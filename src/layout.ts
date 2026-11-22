/**
 * Geometry of OpenScreen's composite: where the recording sits on the output canvas ("stage")
 * and how a zoom region transforms it. Mirrors frameRenderer.ts::updateLayout (padding),
 * compositeLayout.ts::centerRect, focusUtils.ts::clampFocusToScale and
 * zoomTransform.ts::computeZoomTransform for the no-webcam, no-crop case demoreel writes.
 */
import type { Box, Depth, Viewport } from "./types.ts";

/** OpenScreen ZOOM_DEPTH_SCALES (src/components/video-editor/types.ts). */
export const DEPTH_SCALES: Record<Depth, number> = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 };

/** A rectangle in stage-normalised coordinates (0-1 of the output canvas). */
export interface NormRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface StageLayout {
	/** Output canvas aspect ratio (width / height). */
	aspect: number;
	/** The recording's rectangle on the stage, normalised. */
	video: NormRect;
}

export function aspectValue(aspectRatio: string, video: Viewport): number {
	if (aspectRatio === "native") return video.width / video.height;
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio);
	if (!m) return 16 / 9;
	return Number(m[1]) / Number(m[2]);
}

/** Where the (uncropped) recording lands on the output canvas, for a padding of 0-100. */
export function stageLayout(video: Viewport, opts: { padding: number; aspectRatio: string }): StageLayout {
	const aspect = aspectValue(opts.aspectRatio, video);
	const paddingScale = 1 - (Math.min(100, Math.max(0, opts.padding)) / 100) * 0.4;
	// Work on a canvas of height 1 and width `aspect`.
	const maxW = aspect * paddingScale;
	const maxH = paddingScale;
	const scale = Math.min(maxW / video.width, maxH / video.height);
	const w = (video.width * scale) / aspect;
	const h = video.height * scale;
	return { aspect, video: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } };
}

/** Viewport px -> stage-normalised point. */
export function toStage(layout: StageLayout, vp: Viewport, p: { x: number; y: number }) {
	return {
		x: layout.video.x + (p.x / vp.width) * layout.video.w,
		y: layout.video.y + (p.y / vp.height) * layout.video.h,
	};
}

export function boxToStage(layout: StageLayout, vp: Viewport, b: Box): NormRect {
	const a = toStage(layout, vp, b);
	return { x: a.x, y: a.y, w: (b.width / vp.width) * layout.video.w, h: (b.height / vp.height) * layout.video.h };
}

/** OpenScreen clamps the focus so a zoomed view never leaves the stage. */
export function clampFocus(focus: { cx: number; cy: number }, scale: number) {
	const m = Math.min(0.5, 1 / (2 * scale));
	const c = (v: number) => Math.min(1 - m, Math.max(m, Math.min(1, Math.max(0, v))));
	return { cx: c(focus.cx), cy: c(focus.cy) };
}

/** Applies a fully zoomed-in region (scale about the clamped focus) to a stage rect. */
export function zoomRect(r: NormRect, depth: Depth, focus: { cx: number; cy: number }): NormRect {
	const s = DEPTH_SCALES[depth];
	const f = clampFocus(focus, s);
	return { x: 0.5 + (r.x - f.cx) * s, y: 0.5 + (r.y - f.cy) * s, w: r.w * s, h: r.h * s };
}

/** Clips a rect to the unit square; null if nothing is left. */
export function clipUnit(r: NormRect): NormRect | null {
	const x0 = Math.max(0, r.x);
	const y0 = Math.max(0, r.y);
	const x1 = Math.min(1, r.x + r.w);
	const y1 = Math.min(1, r.y + r.h);
	if (x1 - x0 <= 1e-4 || y1 - y0 <= 1e-4) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
