/**
 * Derives OpenScreen zoom regions from the recorded actions' target boxes.
 *
 * Timing is tuned to OpenScreen's zoom envelope (videoPlayback/zoomRegionUtils.ts +
 * constants.ts): a region ramps in over [startMs - 1022, startMs + 500] and out over
 * [endMs, endMs + 1015]; regions less than 1500 ms apart are chained as a pan instead of
 * zooming out and in again.
 *
 * Explicit `scene.zoom()` calls become manual regions that win over automatic ones.
 */
import { DEPTH_SCALES, type StageLayout, stageLayout, toStage } from "./layout.ts";
import { DEFAULT_LOOK } from "./project.ts";
import type { ActionRecord, Box, Depth, Viewport, ZoomHint, ZoomRegion } from "./types.ts";

export { DEPTH_SCALES } from "./layout.ts";

export interface ZoomOptions {
	/** Max fraction of the zoomed view the target may fill (width / height). */
	fillWidth: number;
	fillHeight: number;
	/** Never zoom further than this depth unless a hint forces it. */
	maxDepth: Depth;
	/** Start the region this long before the cursor arrives (zoom is complete at start + 500). */
	leadMs: number;
	/** Keep zoomed this long after the action ended. */
	holdMs: number;
	/** Merge consecutive zoom actions closer than this when their union still zooms. */
	mergeGapMs: number;
	/** Regions shorter than this are dropped. */
	minDurationMs: number;
	/** Turn automatic zooms off entirely (explicit `scene.zoom()` still works). */
	auto: boolean;
	/** Keep the zoomed view inside the recording (no wallpaper at the edges). */
	clampToVideo: boolean;
}

export const DEFAULT_ZOOM_OPTIONS: ZoomOptions = {
	fillWidth: 0.8,
	fillHeight: 0.5,
	maxDepth: 3,
	leadMs: 350,
	holdMs: 800,
	mergeGapMs: 1400,
	minDurationMs: 300,
	auto: true,
	clampToVideo: true,
};

/**
 * Moves a stage-normalised focus so that the view at `depth` stays inside the recording's
 * rectangle (OpenScreen itself only keeps it inside the stage, which shows wallpaper).
 */
export function clampFocusToVideo(focus: { cx: number; cy: number }, depth: Depth, layout: StageLayout) {
	const half = 0.5 / DEPTH_SCALES[depth];
	const v = layout.video;
	const c = (val: number, start: number, size: number) =>
		size <= 2 * half ? start + size / 2 : Math.min(start + size - half, Math.max(start + half, val));
	return { cx: c(focus.cx, v.x, v.w), cy: c(focus.cy, v.y, v.h) };
}

/**
 * Deepest zoom at which `box` (times the hint's context) still fits the configured fill
 * fractions of the zoomed view; null if even the shallowest depth is too much.
 * `videoFraction` is the share of the stage the recording covers (padding shrinks it).
 */
export function depthForBox(
	box: Box,
	vp: Viewport,
	opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS,
	hint?: ZoomHint,
	videoFraction: { w: number; h: number } = { w: 1, h: 1 },
): Depth | null {
	if (hint?.depth) return hint.depth;
	const ctx = hint?.context ?? 1;
	const fitW = (vp.width * opts.fillWidth) / Math.max(1, box.width * ctx * videoFraction.w);
	const fitH = (vp.height * opts.fillHeight) / Math.max(1, box.height * ctx * videoFraction.h);
	const maxScale = Math.min(fitW, fitH, DEPTH_SCALES[opts.maxDepth]);
	let best: Depth | null = null;
	for (const d of [1, 2, 3, 4, 5, 6] as Depth[]) {
		if (DEPTH_SCALES[d] <= maxScale + 1e-6) best = d;
	}
	return best;
}

export function unionBox(a: Box, b: Box): Box {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

interface Pending {
	startMs: number;
	endMs: number;
	box: Box;
	depth: Depth;
	hint?: ZoomHint;
	manual: boolean;
}

const hintOf = (a: ActionRecord) => (typeof a.zoom === "object" ? a.zoom : undefined);

function autoRegions(actions: ActionRecord[], vp: Viewport, opts: ZoomOptions, frac: { w: number; h: number }) {
	const out: Pending[] = [];
	let current: Pending | null = null;
	const flush = (cutAt?: number) => {
		if (!current) return;
		if (cutAt !== undefined) current.endMs = Math.min(current.endMs, cutAt);
		out.push(current);
		current = null;
	};
	for (const a of actions) {
		// Page changes invalidate the focus point: end the zoom before content moves.
		if (a.kind === "scroll" || a.kind === "goto") {
			flush(a.startMs - 150);
			continue;
		}
		if (a.kind === "zoom") continue;
		const target = a.zoomBox ?? a.box;
		if (!target || !a.zoom) continue;
		const hint = hintOf(a);
		const depth = depthForBox(target, vp, opts, hint, frac);
		if (depth === null) continue;
		const startMs = a.arriveMs - opts.leadMs;
		const endMs = a.endMs + opts.holdMs;
		const cur = current as Pending | null;
		if (cur && startMs - cur.endMs < opts.mergeGapMs) {
			const merged = unionBox(cur.box, target);
			const mergedDepth = depthForBox(merged, vp, opts, cur.hint ?? hint, frac);
			// Only merge when the union still zooms nearly as much (else pan between the two).
			if (mergedDepth !== null && mergedDepth >= Math.max(2, Math.min(cur.depth, depth) - 1)) {
				cur.box = merged;
				cur.depth = mergedDepth;
				cur.endMs = endMs;
				continue;
			}
			// cannot merge: chain (OpenScreen pans between regions < 1500ms apart)
			cur.endMs = Math.min(cur.endMs, startMs - 1);
		}
		flush();
		current = { startMs, endMs, box: target, depth, hint, manual: false };
	}
	flush();
	return out;
}

/** Explicit `scene.zoom()` regions. */
function manualRegions(actions: ActionRecord[], vp: Viewport, opts: ZoomOptions, frac: { w: number; h: number }) {
	const out: Pending[] = [];
	for (const a of actions) {
		if (a.kind !== "zoom" || !a.box) continue;
		const hint = hintOf(a);
		const depth = depthForBox(a.box, vp, { ...opts, maxDepth: 6 }, hint, frac) ?? 1;
		out.push({ startMs: a.startMs, endMs: a.endMs, box: a.box, depth, hint, manual: true });
	}
	return out;
}

/** Removes the parts of automatic regions that overlap manual ones (manual zooms win). */
function subtractManual(auto: Pending[], manual: Pending[]) {
	let result = auto;
	for (const m of manual) {
		const next: Pending[] = [];
		for (const r of result) {
			if (r.endMs <= m.startMs || r.startMs >= m.endMs) {
				next.push(r);
				continue;
			}
			if (r.startMs < m.startMs) next.push({ ...r, endMs: m.startMs - 1 });
			if (r.endMs > m.endMs) next.push({ ...r, startMs: m.endMs + 1 });
		}
		result = next;
	}
	return result;
}

export function deriveZoomRegions(
	actions: ActionRecord[],
	vp: Viewport,
	durationMs: number,
	partial: Partial<ZoomOptions> = {},
	layout: StageLayout = stageLayout(vp, DEFAULT_LOOK),
): ZoomRegion[] {
	const opts = { ...DEFAULT_ZOOM_OPTIONS, ...partial };
	const frac = { w: layout.video.w, h: layout.video.h };
	const manual = manualRegions(actions, vp, opts, frac);
	const auto = opts.auto ? subtractManual(autoRegions(actions, vp, opts, frac), manual) : [];
	return [...auto, ...manual]
		.map((r) => ({ ...r, startMs: Math.max(0, r.startMs), endMs: Math.min(durationMs, r.endMs) }))
		.filter((r) => r.endMs - r.startMs > opts.minDurationMs)
		.sort((a, b) => a.startMs - b.startMs)
		.map((r, i) => {
			const p = toStage(layout, vp, { x: r.box.x + r.box.width / 2, y: r.box.y + r.box.height / 2 });
			const c = opts.clampToVideo ? clampFocusToVideo({ cx: p.x, cy: p.y }, r.depth, layout) : { cx: p.x, cy: p.y };
			return {
				id: `zoom-${i + 1}`,
				startMs: Math.round(r.startMs),
				endMs: Math.round(r.endMs),
				depth: r.depth,
				focus: { cx: round4(clamp01(c.cx)), cy: round4(clamp01(c.cy)) },
				focusMode: "manual" as const,
				source: r.manual ? ("manual" as const) : ("auto" as const),
			};
		});
}

function clamp01(v: number) {
	return Math.min(1, Math.max(0, v));
}

function round4(v: number) {
	return Math.round(v * 10000) / 10000;
}
