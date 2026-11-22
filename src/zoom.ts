/**
 * Derives OpenScreen zoom regions from the recorded actions' target boxes.
 *
 * Timing is tuned to OpenScreen's zoom envelope (videoPlayback/zoomRegionUtils.ts +
 * constants.ts): a region ramps in over [startMs - 1022, startMs + 500] and out over
 * [endMs, endMs + 1015]; regions less than 1500 ms apart are chained as a pan instead of
 * zooming out and in again.
 */
import type { ActionRecord, Box, Viewport, ZoomHint, ZoomRegion } from "./types";

/** OpenScreen ZOOM_DEPTH_SCALES (src/components/video-editor/types.ts). */
export const DEPTH_SCALES = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 } as const;
type Depth = keyof typeof DEPTH_SCALES;

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
}

export const DEFAULT_ZOOM_OPTIONS: ZoomOptions = {
	fillWidth: 0.8,
	fillHeight: 0.5,
	maxDepth: 3,
	leadMs: 350,
	holdMs: 800,
	mergeGapMs: 1400,
};

export function depthForBox(box: Box, vp: Viewport, opts: ZoomOptions, hint?: ZoomHint): Depth | null {
	if (hint?.depth) return hint.depth;
	const ctx = hint?.context ?? 1;
	const fitW = (vp.width * opts.fillWidth) / Math.max(1, box.width * ctx);
	const fitH = (vp.height * opts.fillHeight) / Math.max(1, box.height * ctx);
	const maxScale = Math.min(fitW, fitH, DEPTH_SCALES[opts.maxDepth]);
	let best: Depth | null = null;
	for (const d of [1, 2, 3, 4, 5, 6] as Depth[]) {
		if (DEPTH_SCALES[d] <= maxScale + 1e-6) best = d;
	}
	return best;
}

function union(a: Box, b: Box): Box {
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
	labels: string[];
}

export function deriveZoomRegions(
	actions: ActionRecord[],
	vp: Viewport,
	durationMs: number,
	partial: Partial<ZoomOptions> = {},
): ZoomRegion[] {
	const opts = { ...DEFAULT_ZOOM_OPTIONS, ...partial };
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
		if (!a.box || !a.zoom) continue;
		const hint = typeof a.zoom === "object" ? a.zoom : undefined;
		const depth = depthForBox(a.box, vp, opts, hint);
		if (depth === null) continue;
		const startMs = a.arriveMs - opts.leadMs;
		const endMs = a.endMs + opts.holdMs;
		const label = a.label ?? `${a.kind}`;
		const cur = current as Pending | null;
		if (cur && startMs - cur.endMs < opts.mergeGapMs) {
			const merged = union(cur.box, a.box);
			const mergedDepth = depthForBox(merged, vp, opts, cur.hint ?? hint);
			// Only merge when the union still zooms nearly as much (else pan between the two).
			if (mergedDepth !== null && mergedDepth >= Math.max(2, Math.min(cur.depth, depth) - 1)) {
				cur.box = merged;
				cur.depth = mergedDepth;
				cur.endMs = endMs;
				cur.labels.push(label);
				continue;
			}
			// cannot merge: chain (OpenScreen pans between regions < 1500ms apart)
			cur.endMs = Math.min(cur.endMs, startMs - 1);
		}
		flush();
		current = { startMs, endMs, box: a.box, depth, hint, labels: [label] };
	}
	flush();

	return out
		.filter((r) => r.endMs - r.startMs > 300)
		.map((r, i) => ({
			id: `zoom-${i + 1}`,
			startMs: Math.max(0, Math.round(r.startMs)),
			endMs: Math.min(Math.round(durationMs), Math.round(r.endMs)),
			depth: r.depth,
			focus: {
				cx: clamp01((r.box.x + r.box.width / 2) / vp.width),
				cy: clamp01((r.box.y + r.box.height / 2) / vp.height),
			},
			focusMode: "manual" as const,
			source: "auto" as const,
		}));
}

function clamp01(v: number) {
	return Math.min(1, Math.max(0, v));
}
