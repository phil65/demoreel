/**
 * Contact sheets for review. Prefers framesheet (`framesheet inspect video --marks marks.json`,
 * which also scores tiles and checks captions vs. targets), falling back to a plain ffmpeg tile
 * sheet with timestamps.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpegBin, ffprobeBin, run } from "./env.ts";

export async function probeDuration(video: string) {
	const out = await run(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
	return Number(out.trim());
}

/** Plain ffmpeg contact sheet: `n` evenly spaced frames with timestamps. */
export async function contactSheet(video: string, outPng: string, n = 12, cols = 4, width = 480) {
	const duration = await probeDuration(video);
	const rows = Math.ceil(n / cols);
	const offset = (duration / n / 2).toFixed(3);
	// sample at the centre of n equal slices; oversample slightly so rounding never drops a tile
	const fps = n / (duration * 0.985);
	const stamp = `drawtext=text='%{pts\\:hms\\:${offset}}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
	const filters = (withStamp: boolean) =>
		[`fps=${fps.toFixed(6)}`, `scale=${width}:-2`, ...(withStamp ? [stamp] : []), `tile=${cols}x${rows}:padding=4:margin=4`].join(",");
	const args = (vf: string) => ["-y", "-loglevel", "error", "-ss", offset, "-i", video, "-vf", vf, "-frames:v", "1", outPng];
	try {
		await run(ffmpegBin(), args(filters(true)));
	} catch (e) {
		// ffmpeg builds without libfreetype have no drawtext: retry without timestamps.
		if (!/drawtext|No such filter|Filter not found/i.test(String(e))) throw e;
		await run(ffmpegBin(), args(filters(false)));
	}
	return { outPng, duration };
}

export interface FramesheetCommand {
	cmd: string;
	args: string[];
	via: "path" | "node_modules" | "uvx" | "custom";
}

function onPath(bin: string): boolean {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
	return r.status === 0 && Boolean(r.stdout.trim());
}

/** Finds a framesheet CLI: on PATH, in ./node_modules/.bin, or via `uvx framesheet`. */
export function findFramesheet(cwd = process.cwd()): FramesheetCommand | null {
	if (process.env.DEMOREEL_FRAMESHEET) {
		const [cmd, ...args] = process.env.DEMOREEL_FRAMESHEET.split(" ").filter(Boolean);
		return { cmd, args, via: "custom" };
	}
	if (onPath("framesheet")) return { cmd: "framesheet", args: [], via: "path" };
	const local = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "framesheet.cmd" : "framesheet");
	if (fs.existsSync(local)) return { cmd: local, args: [], via: "node_modules" };
	if (onPath("uvx")) return { cmd: "uvx", args: ["framesheet"], via: "uvx" };
	return null;
}

export interface SheetOptions {
	/** Output directory for framesheet / path of the fallback PNG's directory. */
	outDir: string;
	/** framesheet marks file (marks.json). */
	marks?: string;
	/** Number of tiles (default 12). */
	frames?: number;
	/** "auto" (default): framesheet if available; "off": always the ffmpeg sheet. */
	framesheet?: "auto" | "off";
	/** Pass-through args for framesheet (e.g. ["--times", "marks"]). */
	extraArgs?: string[];
	log?: (msg: string) => void;
}

export interface SheetResult {
	tool: "framesheet" | "ffmpeg";
	sheet: string;
	/** framesheet's report.json, if it ran. */
	report?: string;
	/** framesheet's printed summary (findings), if it ran. */
	summary?: string;
	/** framesheet exit code (1 = it reported error-level findings). */
	exitCode?: number;
}

function runCapture(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.stderr.on("data", (d) => {
			err += d;
		});
		p.on("error", (e) => resolve({ code: 127, out, err: String(e) }));
		p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
	});
}

export async function reviewSheet(video: string, opts: SheetOptions): Promise<SheetResult> {
	const log = opts.log ?? (() => {});
	const n = opts.frames ?? 12;
	fs.mkdirSync(opts.outDir, { recursive: true });
	const fsCmd = opts.framesheet === "off" ? null : findFramesheet();
	if (fsCmd) {
		const dir = path.join(opts.outDir, "framesheet");
		const args = [...fsCmd.args, "inspect", video, "--out", dir, "-n", String(n)];
		if (opts.marks && fs.existsSync(opts.marks)) args.push("--marks", opts.marks);
		args.push(...(opts.extraArgs ?? []));
		log(`  framesheet (${fsCmd.via}): ${fsCmd.cmd} ${args.join(" ")}`);
		const r = await runCapture(fsCmd.cmd, args);
		const sheet = path.join(dir, "sheet.png");
		if ((r.code === 0 || r.code === 1) && fs.existsSync(sheet)) {
			const report = path.join(dir, "report.json");
			return {
				tool: "framesheet",
				sheet,
				report: fs.existsSync(report) ? report : undefined,
				summary: r.out.trim(),
				exitCode: r.code,
			};
		}
		log(`  framesheet failed (exit ${r.code}): ${(r.err || r.out).trim().split("\n").slice(-3).join(" | ")}; using the ffmpeg sheet`);
	}
	const png = path.join(opts.outDir, `${path.basename(video).replace(/\.\w+$/, "")}.sheet.png`);
	await contactSheet(video, png, n);
	return { tool: "ffmpeg", sheet: png };
}
