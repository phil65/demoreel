/** `demoreel init`: scaffolds an example scenario (plus a copy of the bundled demo app). */
import fs from "node:fs";
import path from "node:path";
import { DemoreelError } from "./env.ts";
import { PACKAGE_ROOT } from "./openscreen.ts";

export interface InitOptions {
	dir: string;
	/** Scenario name (default "demo"). */
	name?: string;
	/** Record this URL instead of the bundled demo app. */
	url?: string;
	/** Write a .mjs scenario instead of .ts. */
	js?: boolean;
	force?: boolean;
}

export function scenarioTemplate(opts: { name: string; url?: string; js?: boolean; ext?: string }): string {
	const header = opts.js
		? `// @ts-check\nimport { defineScenario } from "demoreel";\n`
		: `import { defineScenario } from "demoreel";\n`;
	if (opts.url) {
		return `${header}
export default defineScenario({
	name: ${JSON.stringify(opts.name)},
	viewport: { width: 1920, height: 1080 },
	async run(scene) {
		await scene.goto(${JSON.stringify(opts.url)});
		await scene.caption("What this page does, in one line", { duration: 3000 });
		// Replace the selectors below with real ones from your page:
		await scene.hover("h1", { dwell: 1200 });
		// await scene.click("text=Get started", { navigates: true });
		// await scene.type("input[type=search]", "hello");
		// await scene.zoom("main", { depth: 2, duration: 2500 });
		// await scene.highlight(".pricing", { duration: 2000 });
		await scene.pause(800);
	},
});
`;
	}
	return `${header}
/** Records the bundled demo app (./demo-app). Run: npx demoreel run ${opts.name}.scenario.${opts.ext ?? (opts.js ? "mjs" : "ts")} */
export default defineScenario({
	name: ${JSON.stringify(opts.name)},
	serve: "./demo-app",
	viewport: { width: 1920, height: 1080 },
	cssZoom: 1.5,
	async run(scene, { baseUrl }) {
		await scene.goto(\`\${baseUrl}/\`);
		await scene.caption("Add a task in seconds", { duration: 3000 });
		await scene.type("#title", "Ship the demo video");
		await scene.type("#owner", "Phil");
		await scene.click("#add", { label: "add task" });
		await scene.pause(600);
		await scene.caption("Filter and complete tasks", { duration: 3500 });
		await scene.click('[data-filter="open"]');
		await scene.click("#list li:nth-child(2) .check", { label: "complete" });
		await scene.highlight("#count", { duration: 1600 });
		await scene.click('[data-filter="all"]');
		await scene.pause(800);
	},
});
`;
}

/** `type` of the nearest package.json ("commonjs" if none says "module"). */
export function packageType(dir: string): "module" | "commonjs" {
	for (let d = path.resolve(dir); ; d = path.dirname(d)) {
		const pj = path.join(d, "package.json");
		if (fs.existsSync(pj)) {
			try {
				return JSON.parse(fs.readFileSync(pj, "utf8")).type === "module" ? "module" : "commonjs";
			} catch {
				return "commonjs";
			}
		}
		if (path.dirname(d) === d) return "commonjs";
	}
}

export function initProject(opts: InitOptions): string[] {
	const dir = path.resolve(opts.dir);
	const name = opts.name ?? "demo";
	// .ts is only ESM in a "type": "module" package; elsewhere use the explicit ESM extensions.
	const esm = packageType(dir) === "module";
	const ext = opts.js ? (esm ? "js" : "mjs") : esm ? "ts" : "mts";
	const file = path.join(dir, `${name}.scenario.${ext}`);
	const written: string[] = [];
	fs.mkdirSync(dir, { recursive: true });
	if (fs.existsSync(file) && !opts.force) throw new DemoreelError(`${file} exists (use --force to overwrite)`);
	fs.writeFileSync(file, scenarioTemplate({ name, url: opts.url, js: opts.js, ext }));
	written.push(file);
	if (!opts.url) {
		const src = path.join(PACKAGE_ROOT, "examples", "demo-app", "index.html");
		const dest = path.join(dir, "demo-app", "index.html");
		if (!fs.existsSync(dest) || opts.force) {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			written.push(dest);
		}
	}
	return written;
}
