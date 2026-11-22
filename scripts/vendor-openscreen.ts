/**
 * Copies the minimal OpenScreen (MIT, github.com/siddharthvaddem/openscreen) module closure
 * needed for headless export into vendor/openscreen/, byte-for-byte, keeping its LICENSE.
 *
 * Usage: bun scripts/vendor-openscreen.ts [path-to-openscreen-checkout]
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const src = path.resolve(
	process.argv[2] ?? path.join(process.env.HOME ?? "", "dev/.oss-worktrees/_openscreen-src"),
);
const dest = path.resolve(import.meta.dir, "../vendor/openscreen");
const ENTRIES = [
	"src/lib/exporter/videoExporter.ts",
	"src/components/video-editor/projectPersistence.ts",
	"src/components/video-editor/timeline/zoomSuggestionUtils.ts",
];
const PUBLIC_ASSETS = ["public/wallpapers/wallpaper1.jpg", "public/wallpapers/wallpaper5.jpg", "public/wallpapers/wallpaper12.jpg"];

const seen = new Set<string>();
const packages = new Set<string>();
const IMPORT_RE =
	/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(spec: string, from: string): string | null {
	let base: string;
	if (spec.startsWith("@/")) base = path.join(src, "src", spec.slice(2));
	else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
	else {
		packages.add(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
		return null;
	}
	const clean = base.split("?")[0];
	for (const c of [clean, `${clean}.ts`, `${clean}.tsx`, `${clean}/index.ts`]) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
	}
	throw new Error(`Cannot resolve ${spec} from ${from}`);
}

function walk(file: string) {
	if (seen.has(file)) return;
	seen.add(file);
	if (!/\.tsx?$/.test(file)) return;
	const text = fs.readFileSync(file, "utf8");
	for (const m of text.matchAll(IMPORT_RE)) {
		const r = resolveSpec(m[1] ?? m[2], file);
		if (r) walk(r);
	}
}

for (const e of ENTRIES) walk(path.join(src, e));
fs.rmSync(dest, { recursive: true, force: true });
const files = [...seen, ...PUBLIC_ASSETS.map((p) => path.join(src, p)), path.join(src, "LICENSE")];
for (const f of files) {
	const rel = path.relative(src, f);
	fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
	fs.copyFileSync(f, path.join(dest, rel));
}
const commit = execSync("git rev-parse HEAD", { cwd: src }).toString().trim();
fs.writeFileSync(
	path.join(dest, "VENDORED.md"),
	`# Vendored OpenScreen modules\n\nUnmodified copies of files from https://github.com/siddharthvaddem/openscreen\n(MIT License, Copyright (c) 2025 Siddharth Vaddem; see LICENSE in this folder),\ncommit \`${commit}\`. Regenerate with \`bun scripts/vendor-openscreen.ts <checkout>\`.\n\nnpm packages required by these files: ${[...packages].sort().join(", ")}\n\nFiles:\n\n${files.map((f) => `- ${path.relative(src, f)}`).sort().join("\n")}\n`,
);
console.log(`vendored ${files.length} files from ${commit.slice(0, 8)}; packages: ${[...packages].join(" ")}`);
