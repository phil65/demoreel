import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, gpuMode, helpText, parseArgs, parseJsonFlag, parseSize, UsageError } from "../src/args.ts";
import { initProject, scenarioTemplate } from "../src/init.ts";
import { loadScenario } from "../src/load.ts";
import { resolveInRoot } from "../src/server.ts";

describe("parseArgs", () => {
	it("parses commands, positionals and typed flags", () => {
		const a = parseArgs(["run", "demo.ts", "--out", "o", "--fps=30", "--no-render", "-v"]);
		expect(a).toMatchObject({ command: "run", positionals: ["demo.ts"], flags: { out: "o", fps: 30, render: false, verbose: true } });
	});
	it("handles aliases and --flag=value booleans", () => {
		expect(parseArgs(["sheet", "x.mp4", "-n", "8", "-o", "d"]).flags).toEqual({ frames: 8, out: "d" });
		expect(parseArgs(["run", "x.ts", "--gpu=false"]).flags.gpu).toBe(false);
	});
	it("gpu is tri-state", () => {
		expect(gpuMode(parseArgs(["render", "p"]).flags)).toBe("auto");
		expect(gpuMode(parseArgs(["render", "p", "--gpu"]).flags)).toBe(true);
		expect(gpuMode(parseArgs(["render", "p", "--no-gpu"]).flags)).toBe(false);
	});
	it("rejects unknown commands/flags, missing values and bad numbers", () => {
		expect(() => parseArgs(["nope"])).toThrow(UsageError);
		expect(() => parseArgs(["run", "x.ts", "--bogus"])).toThrow(/unknown option --bogus/);
		expect(() => parseArgs(["run", "x.ts", "--out"])).toThrow(/needs a value/);
		expect(() => parseArgs(["run", "x.ts", "--fps", "fast"])).toThrow(/number/);
		expect(() => parseArgs(["run"])).toThrow(/usage/);
		expect(() => parseArgs(["run", "a", "b"])).toThrow(/too many/);
		expect(() => parseArgs(["run", "x.ts", "--no-out"])).toThrow(UsageError);
	});
	it("supports --help / --version and -- separator", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["--version"]).version).toBe(true);
		expect(parseArgs(["run", "--help"])).toMatchObject({ command: "run", help: true });
		expect(parseArgs(["run", "--", "--weird.ts"]).positionals).toEqual(["--weird.ts"]);
		expect(parseArgs([]).command).toBeNull();
	});
	it("help text lists every command", () => {
		const h = helpText();
		for (const c of Object.keys(COMMANDS)) expect(h).toContain(c);
		expect(helpText("rezoom")).toContain("--max-depth");
	});
	it("parses sizes and JSON flags", () => {
		expect(parseSize("1280x720")).toEqual({ width: 1280, height: 720 });
		expect(() => parseSize("big")).toThrow(UsageError);
		expect(parseJsonFlag("options", '{"maxDepth":4}')).toEqual({ maxDepth: 4 });
		expect(() => parseJsonFlag("options", "[1]")).toThrow(UsageError);
		expect(parseJsonFlag("options", undefined)).toEqual({});
	});
});

describe("init", () => {
	it("scaffolds a scenario and the demo app", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demoreel-init-"));
		try {
			const files = initProject({ dir });
			expect(files.map((f) => path.relative(dir, f))).toEqual(["demo.scenario.mts", path.join("demo-app", "index.html")]);
			expect(fs.readFileSync(files[0], "utf8")).toContain('serve: "./demo-app"');
			expect(() => initProject({ dir })).toThrow(/exists/);
			const js = initProject({ dir, js: true, url: "https://example.com", name: "site" });
			expect(js).toHaveLength(1);
			expect(fs.readFileSync(js[0], "utf8")).toContain("https://example.com");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("templates import defineScenario from demoreel", () => {
		expect(scenarioTemplate({ name: "x" })).toContain('from "@phil65/demoreel"');
	});
});

describe("loadScenario", () => {
	const fx = (f: string) => path.join(import.meta.dirname, "fixtures", f);
	it("loads plain object and defineScenario exports", async () => {
		expect((await loadScenario(fx("plain.scenario.mjs"))).name).toBe("plain");
		expect((await loadScenario(fx("tiny.scenario.ts"))).name).toBe("tiny");
	});
	it("explains a missing default export", async () => {
		await expect(loadScenario(fx("bad.scenario.mjs"))).rejects.toThrow(/does not export a scenario/);
	});
});

describe("static server path resolution", () => {
	it("stays inside the root", () => {
		const root = path.join(import.meta.dirname, "..", "examples", "demo-app");
		expect(resolveInRoot(root, "/")).toBe(path.join(root, "index.html"));
		expect(resolveInRoot(root, "/../../package.json")).toBeNull();
		expect(resolveInRoot(root, "/%2e%2e/%2e%2e/package.json")).toBeNull();
		expect(resolveInRoot(root, "/missing.js")).toBeNull();
	});
});
