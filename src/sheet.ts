/** Contact sheet of N evenly spaced frames (ffmpeg tile filter) for quick visual review. */
import { run } from "./recorder";

export async function probeDuration(video: string) {
	const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
	return Number(out.trim());
}

export async function contactSheet(video: string, outPng: string, n = 12, cols = 4, width = 480) {
	const duration = await probeDuration(video);
	const rows = Math.ceil(n / cols);
	const offset = (duration / n / 2).toFixed(3);
	// sample at the centre of n equal slices
	// slightly oversample so float rounding never drops the last tile
	const fps = n / (duration * 0.985);
	const vf = [
		`fps=${fps.toFixed(6)}`,
		`scale=${width}:-2`,
		`drawtext=text='%{pts\\:hms\\:${offset}}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`,
		`tile=${cols}x${rows}:padding=4:margin=4`,
	].join(",");
	await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", offset, "-i", video, "-vf", vf, "-frames:v", "1", outPng]);
	return { outPng, duration };
}
