/** Runs a scenario in headless Chromium, records it and writes the OpenScreen project. */
import fs from "node:fs";
import path from "node:path";
import { type ComposeResult, compose } from "./compose.ts";
import { checkFfmpeg, launchChromium } from "./env.ts";
import type { IdleOptions } from "./idle.ts";
import type { LookOptions } from "./project.ts";
import { ScreencastRecorder } from "./recorder.ts";
import { type PacingOptions, Scene } from "./scene.ts";
import { type StaticServer, serveStatic } from "./server.ts";
import type { RecordingResult, Viewport } from "./types.ts";
import type { ZoomOptions } from "./zoom.ts";

export interface ScenarioContext {
	/** URL of the scenario's `serve` directory ("" if none). */
	baseUrl: string;
}

export interface Scenario {
	/** Output file stem (`<name>.openscreen`, `<name>.mp4`). */
	name: string;
	/** Browser viewport == recorded frame size in px (default 1920x1080). */
	viewport?: Viewport;
	/**
	 * Enlarge the page with CSS `zoom` on <html> (1.5 => a 1920x1080 recording lays out like a
	 * 1280x720 page at 1.5x). Chromium's screencast ignores deviceScaleFactor (frames are in DIP),
	 * so this is the only way to get "retina" pixels. Media queries still see the full viewport,
	 * so only use it for pages whose layout you control.
	 */
	cssZoom?: number;
	/** Static directory (relative to the scenario file) served at `ctx.baseUrl`. */
	serve?: string;
	colorScheme?: "light" | "dark";
	/** Seed for the cursor-path jitter (same seed => same motion). */
	seed?: number;
	pacing?: Partial<PacingOptions>;
	zoom?: Partial<ZoomOptions>;
	look?: Partial<LookOptions>;
	/** Cut (or speed up) idle stretches with OpenScreen trim/speed regions. */
	trimIdle?: boolean | Partial<IdleOptions>;
	run(scene: Scene, ctx: ScenarioContext): Promise<void>;
}

/** Identity helper that gives scenario files type checking and editor completion. */
export function defineScenario(s: Scenario): Scenario {
	return s;
}

export interface RecordOptions {
	/** Output directory (default: out/<name>). */
	outDir?: string;
	/** Path of the scenario file; `serve` is resolved relative to it (default: cwd). */
	scenarioFile?: string;
	/** Override scenario fields (e.g. from CLI flags). */
	overrides?: Partial<Omit<Scenario, "run" | "name">>;
	/** Show the browser while recording (debugging; the recording then includes OS chrome timing). */
	headed?: boolean;
	log?: (msg: string) => void;
}

export interface RecordResult extends ComposeResult {
	result: RecordingResult;
	outDir: string;
	zoomRegions: ComposeResult["timeline"]["zoomRegions"];
}

export async function recordScenario(input: Scenario, opts: RecordOptions = {}): Promise<RecordResult> {
	const scenario: Scenario = { ...input, ...opts.overrides };
	if (!scenario.name || typeof scenario.run !== "function") {
		throw new Error("a scenario needs a `name` and an async `run(scene, ctx)` (use defineScenario)");
	}
	checkFfmpeg();
	const outDir = path.resolve(opts.outDir ?? path.join("out", scenario.name));
	const timings: Record<string, number> = {};
	const t0 = Date.now();
	fs.mkdirSync(outDir, { recursive: true });
	const viewport = scenario.viewport ?? { width: 1920, height: 1080 };
	const framesDir = path.join(outDir, ".frames");
	fs.rmSync(framesDir, { recursive: true, force: true });

	const baseDir = opts.scenarioFile ? path.dirname(path.resolve(opts.scenarioFile)) : process.cwd();
	let server: StaticServer | null = null;
	if (scenario.serve) {
		const dir = path.resolve(baseDir, scenario.serve);
		if (!fs.existsSync(dir)) throw new Error(`scenario.serve: ${dir} does not exist`);
		server = await serveStatic(dir);
	}
	const browser = await launchChromium({ headless: !opts.headed });
	let recorder: ScreencastRecorder | null = null;
	let scene: Scene | null = null;
	try {
		const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scenario.colorScheme ?? "light" });
		if (scenario.cssZoom && scenario.cssZoom !== 1) {
			await context.addInitScript((z) => {
				const apply = () => document.documentElement?.style.setProperty("zoom", String(z), "important");
				apply();
				new MutationObserver(apply).observe(document, { childList: true });
				document.addEventListener("DOMContentLoaded", apply);
			}, scenario.cssZoom);
		}
		const page = await context.newPage();
		scene = new Scene(
			page,
			viewport,
			async () => {
				recorder = new ScreencastRecorder(page, framesDir, { maxWidth: viewport.width, maxHeight: viewport.height });
				await recorder.start();
				return recorder;
			},
			{ seed: scenario.seed, pacing: scenario.pacing },
		);
		const tRun = Date.now();
		await scenario.run(scene, { baseUrl: server?.url ?? "" });
		// Hold the last frame so the final zoom-out and captions finish.
		const lastCaptionEnd = Math.max(0, ...scene.captions.map((c) => c.endMs));
		await scene.pause(Math.max(900, lastCaptionEnd - scene.now() + 300));
		timings.scenarioMs = Date.now() - tRun;
	} catch (e) {
		await browser.close().catch(() => {});
		await server?.close();
		throw e;
	}
	const rec = recorder as ScreencastRecorder | null;
	if (!rec || !scene) {
		await browser.close().catch(() => {});
		await server?.close();
		throw new Error("scenario never started recording (call scene.goto first)");
	}
	const { durationMs, frameCount } = await rec.stop();
	await browser.close();
	await server?.close();

	const videoPath = path.join(outDir, "recording.mp4");
	const tEnc = Date.now();
	await rec.encode(videoPath, 30);
	timings.encodeMs = Date.now() - tEnc;
	const frameTimes = rec.frameTimes;
	fs.rmSync(framesDir, { recursive: true, force: true });
	timings.recordTotalMs = Date.now() - t0;

	const composed = compose({
		name: scenario.name,
		outDir,
		videoPath,
		durationMs,
		frameCount,
		viewport,
		frameSize: rec.frameSize,
		actions: scene.actions,
		captions: scene.captions,
		samples: scene.samples,
		frameTimes,
		timings,
		zoom: scenario.zoom,
		look: scenario.look,
		trimIdle: scenario.trimIdle,
	});
	const result: RecordingResult = {
		videoPath,
		durationMs,
		frameSize: rec.frameSize,
		viewport,
		samples: scene.samples,
		actions: scene.actions,
		captions: scene.captions,
		frameTimes,
		frameCount,
		timings,
	};
	return { ...composed, result, outDir, zoomRegions: composed.timeline.zoomRegions };
}
