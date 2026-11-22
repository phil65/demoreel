/**
 * Viewport recorder based on CDP `Page.startScreencast`.
 *
 * Every frame carries the compositor's swap timestamp, so we keep exact timing and later let
 * ffmpeg turn the variable-rate JPEG stream into a constant-rate H.264 MP4 (concat demuxer with
 * per-frame durations). Chromium only emits frames when something changes; idle periods simply
 * become long frame durations.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

interface FrameInfo {
	file: string;
	/** epoch ms (compositor clock) */
	ts: number;
}

export interface ScreencastOptions {
	quality?: number;
	maxWidth: number;
	maxHeight: number;
}

export class ScreencastRecorder {
	private session: CDPSession | null = null;
	private frames: FrameInfo[] = [];
	private pending: Promise<unknown>[] = [];
	private stopTs = 0;
	private firstFrame: Promise<void>;
	private resolveFirst!: () => void;
	frameSize = { width: 0, height: 0 };

	constructor(
		private page: Page,
		private dir: string,
		private opts: ScreencastOptions,
	) {
		fs.mkdirSync(dir, { recursive: true });
		this.firstFrame = new Promise((r) => {
			this.resolveFirst = r;
		});
	}

	/** Epoch ms of the first frame; all telemetry is expressed relative to this. */
	get t0(): number {
		return this.frames[0]?.ts ?? 0;
	}

	async start() {
		const session = await this.page.context().newCDPSession(this.page);
		this.session = session;
		session.on("Page.screencastFrame", (ev) => {
			const index = this.frames.length;
			const file = path.join(this.dir, `f${String(index).padStart(6, "0")}.jpg`);
			const ts = (ev.metadata.timestamp ?? Date.now() / 1000) * 1000;
			this.frames.push({ file, ts });
			this.pending.push(fs.promises.writeFile(file, Buffer.from(ev.data, "base64")));
			if (index === 0) {
				this.frameSize = {
					width: Math.round(ev.metadata.deviceWidth * (ev.metadata.pageScaleFactor ?? 1)),
					height: Math.round(ev.metadata.deviceHeight * (ev.metadata.pageScaleFactor ?? 1)),
				};
				this.resolveFirst();
			}
			session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
		});
		await session.send("Page.startScreencast", {
			format: "jpeg",
			quality: this.opts.quality ?? 92,
			maxWidth: this.opts.maxWidth,
			maxHeight: this.opts.maxHeight,
			everyNthFrame: 1,
		});
		// Nudge a repaint so the first frame arrives even on a static page.
		await this.page.evaluate(() => {
			const el = document.createElement("div");
			el.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none";
			document.body.appendChild(el);
			requestAnimationFrame(() => requestAnimationFrame(() => el.remove()));
		});
		await this.firstFrame;
	}

	/** Current time on the recording clock (ms since first frame). */
	now(): number {
		return Date.now() - this.t0;
	}

	async stop(): Promise<{ durationMs: number; frameCount: number }> {
		this.stopTs = Date.now();
		await this.session?.send("Page.stopScreencast").catch(() => {});
		await Promise.all(this.pending);
		return { durationMs: this.stopTs - this.t0, frameCount: this.frames.length };
	}

	/**
	 * Encode the captured frames to a CFR H.264 MP4: for every output frame time we pick the
	 * latest captured frame (sample-and-hold) and pipe its JPEG to ffmpeg, so timing is exact.
	 */
	async encode(outPath: string, fps = 30) {
		const first = await fs.promises.readFile(this.frames[0].file);
		this.frameSize = jpegSize(first) ?? this.frameSize;
		const total = Math.max(1, Math.round(((this.stopTs - this.t0) / 1000) * fps));
		const ff = spawn(
			"ffmpeg",
			[
				"-y", "-loglevel", "error",
				"-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
				"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
				"-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", String(fps),
				"-movflags", "+faststart", outPath,
			],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		let err = "";
		ff.stderr.on("data", (d) => {
			err += d;
		});
		const done = new Promise<void>((resolve, reject) => {
			ff.on("error", reject);
			ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
		});
		let idx = 0;
		let cachedIdx = -1;
		let cached: Buffer = first;
		for (let k = 0; k < total; k++) {
			const t = this.t0 + (k * 1000) / fps;
			while (idx + 1 < this.frames.length && this.frames[idx + 1].ts <= t) idx++;
			if (idx !== cachedIdx) {
				cached = await fs.promises.readFile(this.frames[idx].file);
				cachedIdx = idx;
			}
			if (!ff.stdin.write(cached)) await new Promise((r) => ff.stdin.once("drain", r));
		}
		ff.stdin.end();
		await done;
		return { outputFrames: total };
	}
}

/** Reads width/height from a JPEG's SOF marker. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) return null;
		const marker = buf[i + 1];
		const len = buf.readUInt16BE(i + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + len;
	}
	return null;
}

export function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.stderr.on("data", (d) => {
			err += d;
		});
		p.on("error", reject);
		p.on("close", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`)),
		);
	});
}
