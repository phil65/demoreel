/** Runs a scenario in headless Chromium, records it and writes the OpenScreen project. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { buildCursorData, buildProject, type LookOptions, writeProject } from "./project";
import { ScreencastRecorder } from "./recorder";
import { type PacingOptions, Scene } from "./scene";
import type { RecordingResult, Viewport } from "./types";
import { deriveZoomRegions, type ZoomOptions } from "./zoom";

export interface Scenario {
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
	seed?: number;
	pacing?: Partial<PacingOptions>;
	zoom?: Partial<ZoomOptions>;
	look?: Partial<LookOptions>;
	run(scene: Scene, ctx: { baseUrl: string }): Promise<void>;
}

export function defineScenario(s: Scenario): Scenario {
	return s;
}

function serveStatic(dir: string): Promise<{ url: string; close: () => void }> {
	const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
	const server = http.createServer((req, res) => {
		const u = new URL(req.url ?? "/", "http://x");
		let file = path.join(dir, decodeURIComponent(u.pathname));
		if (!file.startsWith(dir)) return void res.writeHead(403).end();
		if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
		if (!fs.existsSync(file)) return void res.writeHead(404).end();
		res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const a = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${a.port}`, close: () => server.close() });
		}),
	);
}

export async function recordScenario(scenario: Scenario, scenarioFile: string, outDir: string) {
	const timings: Record<string, number> = {};
	const t0 = Date.now();
	fs.mkdirSync(outDir, { recursive: true });
	const viewport = scenario.viewport ?? { width: 1920, height: 1080 };
	const framesDir = path.join(outDir, ".frames");
	fs.rmSync(framesDir, { recursive: true, force: true });

	const server = scenario.serve ? await serveStatic(path.resolve(path.dirname(scenarioFile), scenario.serve)) : null;
	const browser = await chromium.launch({ headless: true });
	let recorder: ScreencastRecorder | null = null;
	let scene: Scene;
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
				recorder = new ScreencastRecorder(page, framesDir, {
					maxWidth: viewport.width,
					maxHeight: viewport.height,
				});
				await recorder.start();
				return recorder;
			},
			{ seed: scenario.seed, pacing: scenario.pacing },
		);
		const tRun = Date.now();
		await scenario.run(scene, { baseUrl: server?.url ?? "" });
		await scene.pause(900);
		timings.scenarioMs = Date.now() - tRun;
	} finally {
		server?.close();
	}
	const rec = recorder as ScreencastRecorder | null;
	if (!rec) throw new Error("scenario never started recording (call scene.goto first)");
	const { durationMs, frameCount } = await rec.stop();
	await browser.close();

	const videoPath = path.join(outDir, "recording.mp4");
	const tEnc = Date.now();
	const enc = await rec.encode(videoPath, 30);
	void enc;
	timings.encodeMs = Date.now() - tEnc;
	fs.rmSync(framesDir, { recursive: true, force: true });

	const zoomRegions = deriveZoomRegions(scene.actions, viewport, durationMs, scenario.zoom);
	const project = buildProject({ videoPath, zoomRegions, captions: scene.captions, look: scenario.look });
	const cursorData = buildCursorData(scene.samples);
	const projectPath = writeProject(outDir, scenario.name, project, videoPath, cursorData);
	timings.recordTotalMs = Date.now() - t0;

	const result: RecordingResult = {
		videoPath,
		durationMs,
		frameSize: rec.frameSize,
		viewport,
		samples: scene.samples,
		actions: scene.actions,
		captions: scene.captions,
		frameCount,
		timings,
	};
	// Machine-readable log for agents / the optimisation loop.
	fs.writeFileSync(
		path.join(outDir, "timeline.json"),
		JSON.stringify({ scenario: scenario.name, durationMs, frameCount, viewport, frameSize: rec.frameSize, actions: scene.actions, zoomRegions, captions: scene.captions, timings }, null, 2),
	);
	return { result, projectPath, zoomRegions };
}
