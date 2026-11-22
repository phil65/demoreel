/**
 * Writes an OpenScreen v2 project (`*.openscreen`) plus the cursor sidecar
 * (`<video>.cursor.json`, the file OpenScreen's main process reads in
 * electron/ipc/handlers.ts::readCursorRecordingFile).
 */
import fs from "node:fs";
import path from "node:path";
import type { Caption, CursorSample, ZoomRegion } from "./types";

export const PROJECT_VERSION = 2;
export const CURSOR_TELEMETRY_VERSION = 2;

export interface LookOptions {
	/** Wallpaper: "#hex", CSS gradient, or one of OpenScreen's "/wallpapers/wallpaperN.jpg". */
	wallpaper: string;
	padding: number;
	borderRadius: number;
	shadowIntensity: number;
	motionBlurAmount: number;
	aspectRatio: string;
}

export const DEFAULT_LOOK: LookOptions = {
	wallpaper: "linear-gradient(135deg, #1f2a6b 0%, #5b3fa8 55%, #c0589b 100%)",
	padding: 40,
	borderRadius: 14,
	shadowIntensity: 0.6,
	motionBlurAmount: 0.2,
	aspectRatio: "16:9",
};

export function captionAnnotations(captions: Caption[]) {
	return captions.map((c, i) => ({
		id: `annotation-${i + 1}`,
		startMs: Math.round(c.startMs),
		endMs: Math.round(c.endMs),
		type: "text",
		content: c.text,
		textContent: c.text,
		position: { x: 15, y: 88.5 },
		size: { width: 70, height: 8 },
		style: {
			color: "#ffffff",
			backgroundColor: "rgba(12, 14, 28, 0.72)",
			fontSize: 30,
			fontFamily: "Inter, 'DejaVu Sans', system-ui, sans-serif",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: i + 1,
	}));
}

export function buildProject(opts: {
	videoPath: string;
	zoomRegions: ZoomRegion[];
	captions: Caption[];
	look?: Partial<LookOptions>;
}) {
	const look = { ...DEFAULT_LOOK, ...opts.look };
	return {
		version: PROJECT_VERSION,
		// Legacy field: OpenScreen <= 1.2 (v1 projects) only reads `videoPath`; >= 1.3 prefers `media`.
		videoPath: path.resolve(opts.videoPath),
		media: {
			screenVideoPath: path.resolve(opts.videoPath),
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
			trimRegions: [],
			speedRegions: [],
			annotationRegions: captionAnnotations(opts.captions),
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

export function buildCursorData(samples: CursorSample[]) {
	return {
		version: CURSOR_TELEMETRY_VERSION,
		provider: "none" as const,
		samples: samples.map((s) => ({
			timeMs: Math.round(s.timeMs * 10) / 10,
			cx: round4(s.cx),
			cy: round4(s.cy),
			assetId: null,
			visible: s.visible ?? true,
			cursorType: s.cursorType ?? "arrow",
			interactionType: s.interactionType ?? "move",
		})),
		assets: [],
	};
}

function round4(v: number) {
	return Math.round(v * 10000) / 10000;
}

export function writeProject(outDir: string, name: string, project: unknown, videoPath: string, cursorData: unknown) {
	const projectPath = path.join(outDir, `${name}.openscreen`);
	fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
	fs.writeFileSync(`${videoPath}.cursor.json`, JSON.stringify(cursorData));
	return projectPath;
}
