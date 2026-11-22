/** Compiles src/ to dist/ (ESM + .d.ts) with tsc and marks the CLI executable. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(ROOT, "dist");
for (const f of fs.readdirSync(dist, { withFileTypes: true })) {
	// keep the renderer bundles, replace compiled modules
	if (f.isFile() && /\.(js|d\.ts)$/.test(f.name)) fs.rmSync(path.join(dist, f.name));
}
const tsc = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
execFileSync(tsc, ["-p", path.join(ROOT, "tsconfig.build.json")], { stdio: "inherit", cwd: ROOT });
fs.chmodSync(path.join(dist, "cli.js"), 0o755);
console.log("built dist/*.js + .d.ts");
