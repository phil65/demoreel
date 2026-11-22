/**
 * Headless export: serves the prebuilt renderer bundle (dist/renderer, OpenScreen's
 * VideoExporter) from a tiny local server, opens it in headless Chromium and lets OpenScreen's
 * own WebCodecs + Pixi pipeline render the MP4. Validation runs OpenScreen's
 * validateProjectData / normalizeProjectEditor in Node (dist/openscreen/project.js).
 */
import fs from "node:fs";
import path from "node:path";
import { DemoreelError, type GpuMode, launchChromium, renderArgs } from "./env.ts";
import { openscreenProjectApi, rendererDir } from "./openscreen.ts";
import { type Handler, sendFile, serveStatic } from "./server.ts";

export interface CursorStyle {
	/** Cursor scale (OpenScreen default 3). */
	size?: number;
	smoothing?: number;
	motionBlur?: number;
	clickBounce?: number;
	show?: boolean;
}

export interface RenderOptions {
	projectPath: string;
	/** Default: the project path with `.mp4`. */
	outputPath?: string;
	frameRate?: number;
	/** OpenScreen export quality: medium (720p), good (1080p), source. Default: the project's. */
	quality?: "medium" | "good" | "source";
	cursor?: CursorStyle;
	/** `"auto"` (default): use the GPU if one works, else SwiftShader with a warning. */
	gpu?: GpuMode;
	/** Print browser console output. */
	verbose?: boolean;
	/** Progress / warning logger (default: console.error). */
	log?: (msg: string) => void;
	/** Called with 0-100. */
	onProgress?: (percent: number) => void;
	timeoutMs?: number;
}

export interface RenderResult {
	outputPath: string;
	width: number;
	height: number;
	bitrate: number;
	bytes: number;
	warnings: string[];
	gpu: boolean;
	renderMs: number;
	setupMs: number;
	totalMs: number;
}

function readProject(projectPath: string) {
	if (!fs.existsSync(projectPath)) throw new DemoreelError(`project not found: ${projectPath}`);
	try {
		return JSON.parse(fs.readFileSync(projectPath, "utf8"));
	} catch (e) {
		throw new DemoreelError(`${projectPath} is not valid JSON: ${(e as Error).message}`);
	}
}

/** Resolves the project's screen video (absolute, or relative to the project file). */
export function projectVideoPath(project: { media?: { screenVideoPath?: string }; videoPath?: string }, projectPath: string) {
	const v = project.media?.screenVideoPath ?? project.videoPath;
	if (!v) throw new DemoreelError(`${projectPath} has no media.screenVideoPath`);
	const p = v.startsWith("file://") ? new URL(v).pathname : v;
	return path.isAbsolute(p) ? p : path.resolve(path.dirname(projectPath), p);
}

export async function renderProject(opts: RenderOptions): Promise<RenderResult> {
	const t0 = Date.now();
	const log = opts.log ?? ((m: string) => console.error(m));
	const projectPath = path.resolve(opts.projectPath);
	const project = readProject(projectPath);
	const v = await validateProject(projectPath);
	if (!v.valid) throw new DemoreelError(`${projectPath} fails OpenScreen's validateProjectData()`);
	const videoPath = projectVideoPath(project, projectPath);
	if (!fs.existsSync(videoPath)) throw new DemoreelError(`recording not found: ${videoPath}`, "re-run `demoreel run`");
	const cursorFile = `${videoPath}.cursor.json`;
	const cursorData = fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")) : null;
	const outputPath = path.resolve(opts.outputPath ?? projectPath.replace(/\.openscreen$/, "") + ".mp4");
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	const mediaUrl = `/__demoreel/media/${encodeURIComponent(path.basename(videoPath))}`;

	const handlers: Handler[] = [
		(req, res, url) => {
			if (url.pathname !== mediaUrl) return false;
			sendFile(req, res, videoPath);
			return true;
		},
		(req, res, url) => {
			if (url.pathname !== "/__demoreel/output" || req.method !== "POST") return false;
			const tmp = `${outputPath}.part`;
			const out = fs.createWriteStream(tmp);
			req.pipe(out);
			out.on("finish", () => {
				fs.renameSync(tmp, outputPath);
				res.writeHead(200).end("ok");
			});
			out.on("error", (e) => res.writeHead(500).end(String(e)));
			return true;
		},
	];
	const server = await serveStatic(rendererDir(), handlers);
	const gl = await renderArgs(opts.gpu ?? "auto", log);
	const browser = await launchChromium({ args: gl.args });
	try {
		const page = await browser.newPage();
		page.on("console", (m) => {
			const t = m.text();
			if (t.startsWith("[demoreel] progress ")) {
				opts.onProgress?.(Number(t.slice(20)));
				return;
			}
			if (opts.verbose) log(`  [browser] ${t}`);
		});
		const pageErrors: string[] = [];
		page.on("pageerror", (e) => {
			pageErrors.push(e.message);
			if (opts.verbose) log(`  [pageerror] ${e.message}`);
		});
		await page.goto(`${server.url}/index.html`);
		await page.waitForFunction(() => (window as unknown as { demoreelReady?: boolean }).demoreelReady, null, {
			timeout: 60_000,
		});
		const tReady = Date.now();
		const result = await page.evaluate(
			(req) => (window as unknown as { demoreel: { render(r: unknown): Promise<Record<string, unknown>> } }).demoreel.render(req),
			{
				project,
				cursorData,
				videoUrl: mediaUrl,
				frameRate: opts.frameRate ?? 30,
				quality: opts.quality,
				cursor: opts.cursor,
			},
		);
		return {
			outputPath,
			width: result.width as number,
			height: result.height as number,
			bitrate: result.bitrate as number,
			bytes: result.bytes as number,
			warnings: (result.warnings as string[]) ?? [],
			renderMs: result.renderMs as number,
			gpu: gl.gpu,
			setupMs: tReady - t0,
			totalMs: Date.now() - t0,
		};
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		if (/VideoEncoder|isConfigSupported|codec/i.test(msg) && !/upload/.test(msg)) {
			throw new DemoreelError(`render failed in OpenScreen's exporter: ${msg.split("\n")[0]}`, "try --no-gpu, or `demoreel doctor`");
		}
		throw e;
	} finally {
		await browser.close().catch(() => {});
		await server.close();
	}
}

export interface ValidationResult {
	valid: boolean;
	/** Media paths as OpenScreen resolves them. */
	media: unknown;
	/** Editor fields OpenScreen's normalizeProjectEditor would change (should be empty). */
	changedByNormalize: string[];
	/** The normalised editor state (what OpenScreen would load). */
	normalized: Record<string, unknown> | null;
}

/** Runs OpenScreen's own validateProjectData / normalizeProjectEditor on a project (file or object). */
export async function validateProject(project: string | Record<string, unknown>): Promise<ValidationResult> {
	const data = typeof project === "string" ? readProject(path.resolve(project)) : project;
	const os = await openscreenProjectApi();
	const valid = os.validateProjectData(data);
	if (!valid) return { valid: false, media: null, changedByNormalize: [], normalized: null };
	const normalized = os.normalizeProjectEditor((data as { editor: unknown }).editor);
	const changedByNormalize: string[] = [];
	for (const [k, v] of Object.entries((data as { editor: Record<string, unknown> }).editor)) {
		if (JSON.stringify(v) !== JSON.stringify(normalized[k])) changedByNormalize.push(k);
	}
	return { valid, media: os.resolveProjectMedia(data), changedByNormalize, normalized };
}
