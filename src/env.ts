/**
 * Runtime environment: Playwright/Chromium, ffmpeg and GPU detection, with errors that say
 * exactly how to fix the problem.
 */
import { spawn, spawnSync } from "node:child_process";
import type { Browser, BrowserType, LaunchOptions } from "playwright";

export class DemoreelError extends Error {
	readonly fix?: string;
	constructor(message: string, fix?: string) {
		super(fix ? `${message}\n  fix: ${fix}` : message);
		this.name = "DemoreelError";
		this.fix = fix;
	}
}

const isLinux = process.platform === "linux";
export const INSTALL_CHROMIUM = isLinux ? "npx playwright install --with-deps chromium" : "npx playwright install chromium";

let chromiumPromise: Promise<BrowserType> | null = null;

/** Playwright's `chromium`, from the `playwright` peer dependency (or `playwright-core`). */
export function loadChromium(): Promise<BrowserType> {
	chromiumPromise ??= (async () => {
		for (const name of ["playwright", "playwright-core"]) {
			try {
				const mod = (await import(name)) as { chromium?: BrowserType; default?: { chromium?: BrowserType } };
				const chromium = mod.chromium ?? mod.default?.chromium;
				if (chromium) return chromium;
			} catch {
				// try the next one
			}
		}
		throw new DemoreelError(
			"Playwright is not installed (demoreel needs it as a peer dependency).",
			`npm install -D playwright && ${INSTALL_CHROMIUM}`,
		);
	})();
	return chromiumPromise;
}

/** Launches headless Chromium, turning Playwright's install errors into actionable ones. */
export async function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
	const chromium = await loadChromium();
	try {
		return await chromium.launch({ headless: true, ...opts });
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		if (/Executable doesn't exist|browserType\.launch: .*not found|Please run the following command/i.test(msg)) {
			throw new DemoreelError("Chromium for Playwright is not installed.", INSTALL_CHROMIUM);
		}
		if (/error while loading shared libraries|Host system is missing dependencies/i.test(msg)) {
			throw new DemoreelError(
				"Chromium cannot start: system libraries are missing.",
				"npx playwright install-deps chromium   (needs sudo)",
			);
		}
		throw e;
	}
}

/** The ffmpeg binary: $DEMOREEL_FFMPEG, $FFMPEG_PATH or `ffmpeg` on PATH. */
export function ffmpegBin(): string {
	return process.env.DEMOREEL_FFMPEG || process.env.FFMPEG_PATH || "ffmpeg";
}

export function ffprobeBin(): string {
	if (process.env.DEMOREEL_FFPROBE) return process.env.DEMOREEL_FFPROBE;
	const ff = ffmpegBin();
	return ff === "ffmpeg" ? "ffprobe" : ff.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
}

const FFMPEG_FIX =
	process.platform === "darwin"
		? "brew install ffmpeg"
		: process.platform === "win32"
			? "winget install ffmpeg   (or set DEMOREEL_FFMPEG=C:\\path\\to\\ffmpeg.exe)"
			: "sudo apt install ffmpeg   (or dnf/pacman; or set DEMOREEL_FFMPEG=/path/to/ffmpeg)";

/** Throws a DemoreelError unless ffmpeg (with libx264) is available. */
export function checkFfmpeg(bin = ffmpegBin()): void {
	const r = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" });
	if (r.error || r.status !== 0) {
		throw new DemoreelError(`ffmpeg not found (tried "${bin}"); it encodes the recording.`, FFMPEG_FIX);
	}
	if (!/libx264/.test(r.stdout)) {
		throw new DemoreelError(`ffmpeg at "${bin}" has no libx264 encoder.`, FFMPEG_FIX);
	}
}

/** Runs a command, resolving with stdout; rejects with the tail of stderr. */
export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.stderr.on("data", (d) => {
			err += d;
		});
		p.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code === "ENOENT" && /ff(mpeg|probe)/.test(cmd)) reject(new DemoreelError(`${cmd} not found.`, FFMPEG_FIX));
			else reject(e);
		});
		p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`))));
	});
}

// ---- GPU ------------------------------------------------------------------------------------

export const SOFTWARE_GL_ARGS = ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"];

/** Candidate GPU flag sets per platform, best first. */
export function gpuArgCandidates(platform = process.platform): string[][] {
	const base = ["--enable-gpu", "--ignore-gpu-blocklist"];
	if (platform === "darwin") return [[...base, "--use-angle=metal"]];
	if (platform === "win32") return [[...base, "--use-angle=d3d11"]];
	return [
		[...base, "--use-angle=vulkan", "--enable-features=Vulkan"],
		[...base, "--use-angle=gl"],
	];
}

export interface GpuProbe {
	gpu: boolean;
	args: string[];
	renderer: string;
	/** VideoEncoder supports H.264 (avc1.640033) at 1080p. */
	h264: boolean;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/i;

async function probeArgs(args: string[]): Promise<Omit<GpuProbe, "gpu" | "args"> | null> {
	let browser: Browser | null = null;
	try {
		browser = await launchChromium({ args });
		const page = await browser.newPage();
		// WebCodecs needs a secure context; serve a blank page on a fake https origin.
		await page.route("https://demoreel.invalid/**", (r) => r.fulfill({ body: "<html></html>", contentType: "text/html" }));
		await page.goto("https://demoreel.invalid/");
		return await page.evaluate(async () => {
			const gl = document.createElement("canvas").getContext("webgl2");
			let renderer = "none";
			if (gl) {
				const ext = gl.getExtension("WEBGL_debug_renderer_info");
				renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
			}
			let h264 = false;
			try {
				h264 = Boolean(
					(await VideoEncoder.isConfigSupported({ codec: "avc1.640033", width: 1920, height: 1080 })).supported,
				);
			} catch {
				h264 = false;
			}
			return { renderer, h264 };
		});
	} catch (e) {
		if (e instanceof DemoreelError) throw e;
		return null;
	} finally {
		await browser?.close().catch(() => {});
	}
}

let gpuCache: Promise<GpuProbe> | null = null;

/** Finds a working hardware GL flag set, else returns the SwiftShader (software) one. */
export function detectGpu(): Promise<GpuProbe> {
	gpuCache ??= (async () => {
		for (const args of gpuArgCandidates()) {
			const r = await probeArgs(args);
			if (r && r.renderer !== "none" && !SOFTWARE_RENDERER.test(r.renderer)) return { gpu: true, args, ...r };
		}
		const sw = await probeArgs(SOFTWARE_GL_ARGS);
		return { gpu: false, args: SOFTWARE_GL_ARGS, renderer: sw?.renderer ?? "none", h264: sw?.h264 ?? false };
	})();
	return gpuCache;
}

export type GpuMode = boolean | "auto";

/** Chromium args for rendering: GPU when asked/available, SwiftShader otherwise. */
export async function renderArgs(mode: GpuMode, log: (msg: string) => void = () => {}): Promise<{ args: string[]; gpu: boolean; renderer?: string }> {
	if (mode === false) return { args: SOFTWARE_GL_ARGS, gpu: false };
	const probe = await detectGpu();
	if (!probe.h264) {
		throw new DemoreelError(
			"This Chromium build cannot encode H.264 with WebCodecs (needed by OpenScreen's exporter).",
			`${INSTALL_CHROMIUM}   (Playwright's Chromium includes H.264; distro builds may not)`,
		);
	}
	if (probe.gpu) return { args: probe.args, gpu: true, renderer: probe.renderer };
	log(
		`warning: no usable GPU found (WebGL renderer: ${probe.renderer}); rendering with SwiftShader (software), ` +
			"which is several times slower. Use a machine with a GPU, or lower --fps / the viewport for drafts.",
	);
	return { args: probe.args, gpu: false, renderer: probe.renderer };
}
