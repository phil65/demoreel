/**
 * Writes an OpenScreen v2 project (`*.openscreen`) plus the cursor sidecar
 * (`<video>.cursor.json`, the file OpenScreen's main process reads in
 * electron/ipc/handlers.ts::readCursorRecordingFile).
 */
import fs from "node:fs";
import path from "node:path";
import type { Caption, CursorSample, SpeedRegion, TrimRegion, ZoomRegion } from "./types.ts";

export const PROJECT_VERSION = 2;
export const CURSOR_TELEMETRY_VERSION = 2;

export interface LookOptions {
	/** Wallpaper: "#hex", CSS gradient, or one of OpenScreen's "/wallpapers/wallpaperN.jpg". */
	wallpaper: string;
	/** 0-100; 40 => the recording covers 84% of the canvas. */
	padding: number;
	borderRadius: number;
	shadowIntensity: number;
	motionBlurAmount: number;
	/** "16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "10:16" or "native". */
	aspectRatio: string;
	/** Where captions sit; "auto" (default) = bottom, unless that covers an active target. */
	captionPosition: "auto" | "bottom" | "top";
	captionFontSize: number;
}

export const DEFAULT_LOOK: LookOptions = {
	wallpaper: "linear-gradient(135deg, #1f2a6b 0%, #5b3fa8 55%, #c0589b 100%)",
	padding: 40,
	borderRadius: 14,
	shadowIntensity: 0.6,
	motionBlurAmount: 0.2,
	aspectRatio: "16:9",
	captionPosition: "auto",
	captionFontSize: 30,
};

/** Caption box in percent of the output canvas (OpenScreen annotation position/size). */
export function captionRect(position: LookOptions["captionPosition"] | undefined) {
	return { x: 15, y: position === "top" ? 3.5 : 88.5, width: 70, height: 8 };
}

export function captionAnnotations(captions: Caption[], look: LookOptions = DEFAULT_LOOK) {
	return captions.map((c, i) => {
		const r = captionRect(c.position ?? look.captionPosition);
		return {
		id: `annotation-${i + 1}`,
		startMs: Math.round(c.startMs),
		endMs: Math.round(c.endMs),
		type: "text",
		content: c.text,
		textContent: c.text,
		position: { x: r.x, y: r.y },
		size: { width: r.width, height: r.height },
		style: {
			color: "#ffffff",
			backgroundColor: "rgba(12, 14, 28, 0.72)",
			fontSize: look.captionFontSize,
			fontFamily: "Inter, 'DejaVu Sans', system-ui, sans-serif",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: i + 1,
		};
	});
}

export interface BuildProjectOptions {
	videoPath: string;
	zoomRegions: ZoomRegion[];
	captions: Caption[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	look?: Partial<LookOptions>;
}

export type OpenScreenProject = ReturnType<typeof buildProject>;

export function buildProject(opts: BuildProjectOptions) {
	const look = { ...DEFAULT_LOOK, ...opts.look };
	const videoPath = path.resolve(opts.videoPath);
	return {
		version: PROJECT_VERSION,
		// Legacy field: OpenScreen <= 1.2 (v1 projects) only reads `videoPath`; >= 1.3 prefers `media`.
		videoPath,
		media: {
			screenVideoPath: videoPath,
			cursorCaptureMode: "editable-overlay",
		},
		editor: {
			wallpaper: look.wallpaper,
			shadowIntensity: look.shadowIntensity,
			showBlur: false,
			showTrimWaveform: true,
			motionBlurAmount: look.motionBlurAmount,
			borderRadius: look.borderRadius,
			padding: look.padding,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			zoomRegions: opts.zoomRegions,
			autoZoomEnabled: false,
			autoFocusAll: false,
			trimRegions: opts.trimRegions ?? [],
			speedRegions: opts.speedRegions ?? [],
			annotationRegions: captionAnnotations(opts.captions, look),
			aspectRatio: look.aspectRatio,
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "rectangle",
			webcamMirrored: true,
			webcamReactiveZoom: false,
			webcamSizePreset: 25,
			webcamPosition: null,
			exportQuality: "good",
			exportFormat: "mp4",
			gifFrameRate: 15,
			gifLoop: true,
			gifSizePreset: "medium",
			cursorTheme: "default",
		},
	};
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/**
 * Normalises cursor telemetry for OpenScreen: finite, sorted, non-negative times; positions
 * clamped to 0-1; consecutive duplicate samples dropped (clicks are always kept).
 */
export function normalizeSamples(samples: CursorSample[]): Required<CursorSample>[] {
	const sorted = samples
		.filter((s) => Number.isFinite(s.timeMs))
		.map((s, i) => ({ s, i }))
		.sort((a, b) => a.s.timeMs - b.s.timeMs || a.i - b.i)
		.map(({ s }) => s);
	const out: Required<CursorSample>[] = [];
	for (const s of sorted) {
		const n: Required<CursorSample> = {
			timeMs: Math.max(0, Math.round(s.timeMs * 10) / 10),
			cx: round4(clamp01(s.cx)),
			cy: round4(clamp01(s.cy)),
			assetId: s.assetId ?? null,
			visible: s.visible ?? true,
			cursorType: s.cursorType ?? "arrow",
			interactionType: s.interactionType ?? "move",
		};
		const prev = out[out.length - 1];
		if (
			prev &&
			n.interactionType === "move" &&
			prev.interactionType === "move" &&
			prev.cx === n.cx &&
			prev.cy === n.cy &&
			prev.cursorType === n.cursorType &&
			prev.visible === n.visible &&
			n.timeMs - prev.timeMs < 1
		) {
			continue;
		}
		out.push(n);
	}
	return out;
}

export function buildCursorData(samples: CursorSample[]) {
	return {
		version: CURSOR_TELEMETRY_VERSION,
		provider: "none" as const,
		samples: normalizeSamples(samples),
		assets: [] as unknown[],
	};
}

export function writeProject(outDir: string, name: string, project: unknown, videoPath: string, cursorData: unknown) {
	const projectPath = path.join(outDir, `${name}.openscreen`);
	fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
	fs.writeFileSync(`${videoPath}.cursor.json`, JSON.stringify(cursorData));
	return projectPath;
}
