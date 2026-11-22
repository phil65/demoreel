#!/usr/bin/env node
/** demoreel CLI. See `demoreel --help`. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, gpuMode, helpText, parseArgs, parseJsonFlag, parseSize, type ParsedArgs, UsageError } from "./args.ts";
import { readTimeline, rezoom } from "./compose.ts";
import { checkFfmpeg, DemoreelError, detectGpu, launchChromium } from "./env.ts";
import { initProject } from "./init.ts";
import { loadScenario } from "./load.ts";
import { PACKAGE_ROOT } from "./openscreen.ts";
import { type RecordOptions, recordScenario } from "./record.ts";
import { type RenderResult, renderProject, validateProject } from "./render.ts";
import { findFramesheet, reviewSheet } from "./sheet.ts";
import type { ZoomOptions } from "./zoom.ts";

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const log = (msg: string) => console.error(msg);

function progressPrinter(enabled: boolean) {
	let last = -1;
	return (p: number) => {
		if (!enabled) return;
		const step = Math.floor(p / 10) * 10;
		if (step !== last) {
			last = step;
			if (process.stderr.isTTY) process.stderr.write(`\r  rendering ${step}%${step >= 100 ? "\n" : ""}`);
			else if (step % 25 === 0 || step >= 100) log(`  rendering ${step}%`);
		}
	};
}

function printRender(r: RenderResult) {
	log(
		`  rendered ${r.width}x${r.height} ${(r.bytes / 1e6).toFixed(1)} MB in ${fmt(r.renderMs)} (${r.gpu ? "GPU" : "software"}, setup ${fmt(r.setupMs)}) -> ${r.outputPath}`,
	);
	if (r.warnings.length) log(`  warnings: ${r.warnings.join("; ")}`);
}

function renderFlags(flags: ParsedArgs["flags"]) {
	const q = flags.quality as string | undefined;
	if (q && !["medium", "good", "source"].includes(q)) throw new UsageError("--quality must be medium, good or source");
	return {
		gpu: gpuMode(flags),
		frameRate: flags.fps === undefined ? 30 : Number(flags.fps),
		quality: q as "medium" | "good" | "source" | undefined,
		verbose: Boolean(flags.verbose),
	};
}

async function cmdRun({ positionals, flags }: ParsedArgs) {
	const file = path.resolve(positionals[0]);
	if (!fs.existsSync(file)) throw new DemoreelError(`scenario not found: ${file}`, "demoreel init   (scaffolds one)");
	const scenario = await loadScenario(file);
	const out = path.resolve(String(flags.out ?? path.join("out", scenario.name)));
	const overrides: NonNullable<RecordOptions["overrides"]> = {};
	if (flags.viewport) overrides.viewport = parseSize(String(flags.viewport));
	if (flags.speed !== undefined) overrides.pacing = { ...scenario.pacing, speed: Number(flags.speed) };
	if (flags["trim-idle"] !== undefined) overrides.trimIdle = Boolean(flags["trim-idle"]) && (scenario.trimIdle || true);
	log(`recording "${scenario.name}" -> ${out}`);
	const rec = await recordScenario(scenario, { outDir: out, scenarioFile: file, overrides, headed: Boolean(flags.headed), log });
	const { result, timeline } = rec;
	log(
		`  recorded ${fmt(result.durationMs)}, ${result.frameCount} frames @ ${result.frameSize.width}x${result.frameSize.height}, ` +
			`${result.samples.length} cursor samples, ${result.actions.length} actions, ${timeline.zoomRegions.length} zoom regions` +
			(timeline.trimRegions.length ? `, ${timeline.trimRegions.length} idle cuts (-> ${fmt(timeline.outputDurationMs)})` : ""),
	);
	const v = await validateProject(rec.projectPath);
	log(`  OpenScreen validateProjectData: ${v.valid}${v.changedByNormalize.length ? `; normalised: ${v.changedByNormalize.join(", ")}` : ""}`);
	log(`  project:  ${rec.projectPath}`);
	log(`  timeline: ${rec.timelinePath}`);
	log(`  marks:    ${rec.marksPath}`);
	if (flags.render === false) return;
	const mp4 = path.join(out, `${scenario.name}.mp4`);
	const r = await renderProject({
		projectPath: rec.projectPath,
		outputPath: mp4,
		...renderFlags(flags),
		log,
		onProgress: progressPrinter(true),
	});
	printRender(r);
	if (flags.sheet === false) return;
	const sheet = await reviewSheet(mp4, {
		outDir: out,
		marks: rec.marksPath,
		frames: flags.frames as number | undefined,
		framesheet: flags.framesheet === "off" ? "off" : "auto",
		log,
	});
	log(`  contact sheet (${sheet.tool}): ${sheet.sheet}`);
	if (sheet.summary) console.log(sheet.summary);
}

async function cmdRender({ positionals, flags }: ParsedArgs) {
	const projectPath = path.resolve(positionals[0]);
	const r = await renderProject({
		projectPath,
		outputPath: flags.out ? path.resolve(String(flags.out)) : undefined,
		...renderFlags(flags),
		log,
		onProgress: progressPrinter(true),
	});
	printRender(r);
	console.log(r.outputPath);
}

async function cmdRezoom({ positionals, flags }: ParsedArgs) {
	const dir = path.resolve(positionals[0]);
	const zoom = parseJsonFlag("options", flags.options) as Partial<ZoomOptions>;
	if (flags["max-depth"] !== undefined) zoom.maxDepth = Number(flags["max-depth"]) as ZoomOptions["maxDepth"];
	if (flags.lead !== undefined) zoom.leadMs = Number(flags.lead);
	if (flags.hold !== undefined) zoom.holdMs = Number(flags.hold);
	if (flags["auto-zoom"] !== undefined) zoom.auto = Boolean(flags["auto-zoom"]);
	const idle = parseJsonFlag("idle-options", flags["idle-options"]);
	const trimIdle =
		flags["trim-idle"] === false ? false : flags["trim-idle"] || Object.keys(idle).length ? { ...idle } : undefined;
	const res = rezoom(dir, { zoom, trimIdle });
	const t = res.timeline;
	log(
		`rezoomed ${t.scenario}: ${t.zoomRegions.length} zoom regions, ${t.trimRegions.length} trims, ${t.speedRegions.length} speed regions; output ${fmt(t.outputDurationMs)}`,
	);
	console.log(JSON.stringify({ zoomRegions: t.zoomRegions, trimRegions: t.trimRegions, speedRegions: t.speedRegions }, null, 1));
	if (flags.render) {
		const r = await renderProject({ projectPath: res.projectPath, ...renderFlags(flags), log, onProgress: progressPrinter(true) });
		printRender(r);
	}
}

async function cmdValidate({ positionals, flags }: ParsedArgs) {
	const v = await validateProject(path.resolve(positionals[0]));
	if (flags.json) console.log(JSON.stringify(v, null, 2));
	else {
		console.log(`valid: ${v.valid}`);
		if (v.valid) console.log(`changed by normalizeProjectEditor: ${v.changedByNormalize.length ? v.changedByNormalize.join(", ") : "(nothing)"}`);
		if (v.valid) console.log(`media: ${JSON.stringify(v.media)}`);
	}
	if (!v.valid) process.exitCode = 1;
}

async function cmdSheet({ positionals, flags }: ParsedArgs) {
	let target = path.resolve(positionals[0]);
	let marks = flags.marks ? path.resolve(String(flags.marks)) : undefined;
	if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
		const tl = readTimeline(target);
		marks ??= path.join(target, tl.files?.marks ?? "marks.json");
		target = path.join(target, tl.files?.video ?? `${tl.scenario}.mp4`);
	}
	if (!fs.existsSync(target)) throw new DemoreelError(`video not found: ${target}`, "render it first: demoreel render <project>");
	marks ??= path.join(path.dirname(target), "marks.json");
	const sheet = await reviewSheet(target, {
		outDir: flags.out ? path.resolve(String(flags.out)) : path.dirname(target),
		marks,
		frames: flags.frames as number | undefined,
		framesheet: flags.framesheet === "off" ? "off" : "auto",
		log,
	});
	if (sheet.summary) console.log(sheet.summary);
	log(`contact sheet (${sheet.tool}): ${sheet.sheet}`);
	console.log(sheet.sheet);
	if (sheet.report) console.log(sheet.report);
}

function cmdInit({ positionals, flags }: ParsedArgs) {
	const written = initProject({
		dir: positionals[0] ?? ".",
		name: flags.name as string | undefined,
		url: flags.url as string | undefined,
		js: Boolean(flags.js),
		force: Boolean(flags.force),
	});
	for (const f of written) log(`wrote ${path.relative(process.cwd(), f) || f}`);
	const scenario = path.relative(process.cwd(), written[0]);
	log(`\nnext:\n  npm install -D demoreel playwright   # if not installed yet\n  npx demoreel run ${scenario}`);
}

async function cmdDoctor() {
	let ok = true;
	const check = async (name: string, fn: () => Promise<string> | string) => {
		try {
			log(`  ok    ${name}: ${await fn()}`);
		} catch (e) {
			ok = false;
			log(`  FAIL  ${name}: ${(e as Error).message}`);
		}
	};
	log(`demoreel ${version()} on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`} (${process.platform})`);
	await check("chromium", async () => {
		const b = await launchChromium();
		const v = b.version();
		await b.close();
		return v;
	});
	await check("ffmpeg", () => {
		checkFfmpeg();
		return "found, with libx264";
	});
	await check("gpu", async () => {
		const g = await detectGpu();
		if (!g.h264) throw new DemoreelError("WebCodecs H.264 encoding unavailable", "npx playwright install chromium");
		return `${g.gpu ? "hardware" : "software only (renders will be slow)"}: ${g.renderer}`;
	});
	const fsCmd = findFramesheet();
	log(`  ${fsCmd ? "ok  " : "info"}  framesheet: ${fsCmd ? `${fsCmd.cmd} ${fsCmd.args.join(" ")}`.trim() : "not found (sheets fall back to ffmpeg; `uv tool install framesheet` or `npm i -D framesheet`)"}`);
	if (!ok) process.exitCode = 1;
}

function version(): string {
	try {
		return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
	} catch {
		return "unknown";
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (e) {
		if (e instanceof UsageError) {
			log(`error: ${e.message}`);
			process.exitCode = 2;
			return;
		}
		throw e;
	}
	if (args.version) return void console.log(version());
	if (args.help || !args.command) {
		console.log(helpText(args.command));
		return;
	}
	const handlers: Record<keyof typeof COMMANDS, (a: ParsedArgs) => unknown> = {
		run: cmdRun,
		render: cmdRender,
		rezoom: cmdRezoom,
		validate: cmdValidate,
		sheet: cmdSheet,
		init: cmdInit,
		doctor: cmdDoctor,
	};
	try {
		await handlers[args.command](args);
	} catch (e) {
		if (e instanceof DemoreelError || e instanceof UsageError) {
			log(`error: ${e.message}`);
			process.exitCode = e instanceof UsageError ? 2 : 1;
			return;
		}
		throw e;
	}
}

const isMain = (() => {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();

if (isMain) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
