/**
 * framesheet marks (schema: github.com/phil65/framesheet/schema/marks.schema.json) for the
 * rendered video: clicks as points, action targets / highlights / zooms as regions, captions as
 * spans. Times are seconds of the *output* (after trim/speed regions); coordinates are
 * fractions of the output frame, i.e. mapped through the padding layout and the zoom camera,
 * so `framesheet inspect out.mp4 --marks marks.json` draws them where they appear.
 */
import { sourceToOutputMs } from "./idle.ts";
import { clipUnit, DEPTH_SCALES, type NormRect, type StageLayout, boxToStage, clampFocus, toStage } from "./layout.ts";
import { captionRect, type LookOptions } from "./project.ts";
import type { ActionRecord, Caption, SpeedRegion, TrimRegion, Viewport, ZoomRegion } from "./types.ts";

export interface MarkPoint {
	t: number;
	x: number;
	y: number;
	label?: string | null;
	kind?: string | null;
	duration?: number;
}

export interface MarkRegion {
	start: number;
	end: number;
	x?: number | null;
	y?: number | null;
	w?: number | null;
	h?: number | null;
	label?: string | null;
	kind?: string | null;
}

export interface MarkSpan extends MarkRegion {
	label: string;
}

export interface Marks {
	frame?: { width: number; height: number } | null;
	points: MarkPoint[];
	regions: MarkRegion[];
	spans: MarkSpan[];
}

export interface MarksInput {
	viewport: Viewport;
	durationMs: number;
	actions: ActionRecord[];
	captions: Caption[];
	zoomRegions: ZoomRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	layout: StageLayout;
	look: Pick<LookOptions, "captionPosition">;
}

export interface TargetRect {
	action: ActionRecord;
	/** Recording ms. */
	startMs: number;
	endMs: number;
	/** Output-frame rect (clipped), sampled once the cursor has landed. */
	rect: NormRect;
}

/** Action target boxes in output-frame coordinates (padding + zoom camera applied). */
export function targetRects(input: Pick<MarksInput, "actions" | "viewport" | "layout" | "zoomRegions">): TargetRect[] {
	const out: TargetRect[] = [];
	for (const a of input.actions) {
		if (!a.box || a.kind === "zoom") continue;
		// Sample the camera once the cursor has landed (zoom is then (nearly) complete).
		const t = Math.min(a.endMs, a.arriveMs + 300);
		const rect = clipUnit(applyCamera(boxToStage(input.layout, input.viewport, a.box), input.zoomRegions, t));
		if (rect) out.push({ action: a, startMs: a.kind === "highlight" ? a.startMs : a.arriveMs, endMs: a.endMs, rect });
	}
	return out;
}

const overlapArea = (a: NormRect, b: { x: number; y: number; w: number; h: number }) =>
	Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Resolves `captionPosition: "auto"`: bottom, unless the caption would cover a target active
 * while it is shown (with 400 ms slack); then top, if that overlaps less.
 */
export function placeCaptions(captions: Caption[], targets: TargetRect[], position: LookOptions["captionPosition"]): Caption[] {
	return captions.map((c) => {
		if (position !== "auto") return { ...c, position };
		const active = targets.filter((t) => t.endMs >= c.startMs - 400 && t.startMs <= c.endMs + 400);
		const cost = (p: "top" | "bottom") => {
			const r = captionRect(p);
			const box = { x: r.x / 100, y: r.y / 100, w: r.width / 100, h: r.height / 100 };
			return active.reduce((n, t) => n + overlapArea(t.rect, box), 0);
		};
		const bottom = cost("bottom");
		return { ...c, position: bottom > 0 && cost("top") < bottom ? "top" : "bottom" };
	});
}

const ZOOM_IN_BEFORE_MS = 1022;
const ZOOM_IN_AFTER_MS = 500;
const ZOOM_OUT_MS = 1016;
const smooth = (x: number) => {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
};

/** Approximate zoom progress (0-1) of a region at recording time t. */
export function zoomProgress(r: ZoomRegion, t: number): number {
	const inStart = r.startMs - ZOOM_IN_BEFORE_MS;
	if (t <= inStart || t >= r.endMs + ZOOM_OUT_MS) return 0;
	if (t < r.startMs + ZOOM_IN_AFTER_MS) return smooth((t - inStart) / (ZOOM_IN_BEFORE_MS + ZOOM_IN_AFTER_MS));
	if (t <= r.endMs) return 1;
	return 1 - smooth((t - r.endMs) / ZOOM_OUT_MS);
}

/** The camera at time t: the dominant zoom region and its progress. */
export function cameraAt(regions: ZoomRegion[], t: number) {
	let best: { region: ZoomRegion; p: number } | null = null;
	for (const r of regions) {
		const p = zoomProgress(r, t);
		if (p > 0 && (!best || p > best.p)) best = { region: r, p };
	}
	return best;
}

/** Stage rect -> output-frame rect under the camera at time t (OpenScreen computeZoomTransform). */
export function applyCamera(rect: NormRect, regions: ZoomRegion[], t: number): NormRect {
	const cam = cameraAt(regions, t);
	if (!cam) return rect;
	const s = DEPTH_SCALES[cam.region.depth];
	const f = clampFocus(cam.region.focus, s);
	const scale = 1 + (s - 1) * cam.p;
	const ox = (0.5 - f.cx * s) * cam.p;
	const oy = (0.5 - f.cy * s) * cam.p;
	return { x: rect.x * scale + ox, y: rect.y * scale + oy, w: rect.w * scale, h: rect.h * scale };
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function describe(a: ActionRecord): string {
	const what = a.label ?? (a.text ? `"${a.text}"` : undefined);
	return what ? `${a.kind} ${what}` : a.kind;
}

export function buildMarks(input: MarksInput): Marks {
	const { viewport: vp, layout, zoomRegions: zr } = input;
	const out = (ms: number) => r3(Math.max(0, sourceToOutputMs(ms, input.trimRegions, input.speedRegions)) / 1000);
	const endS = out(input.durationMs);
	const box = (rect: NormRect | null) => (rect ? { x: r4(rect.x), y: r4(rect.y), w: r4(rect.w), h: r4(rect.h) } : null);
	const marks: Marks = { points: [], regions: [], spans: [] };

	for (const t of targetRects(input)) {
		const start = out(t.startMs);
		marks.regions.push({
			start,
			end: Math.min(endS, Math.max(start, out(t.endMs))),
			...(box(t.rect) as NormRect),
			label: describe(t.action),
			kind: t.action.kind === "highlight" ? "highlight" : "target",
		});
	}
	for (const a of input.actions) {
		if (a.point && (a.kind === "click" || a.kind === "type")) {
			const t = a.kind === "click" ? a.endMs : a.arriveMs;
			const p = applyCamera({ ...toStage(layout, vp, a.point), w: 0, h: 0 }, zr, t);
			if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
				marks.points.push({
					t: Math.min(endS, out(t)),
					x: r4(p.x),
					y: r4(p.y),
					label: describe(a),
					kind: a.kind,
					...(a.kind === "type" ? { duration: r3(Math.max(0, out(a.endMs) - out(a.arriveMs))) } : {}),
				});
			}
		}
	}

	for (const z of zr) {
		const start = out(z.startMs);
		marks.regions.push({
			start,
			end: Math.max(start, Math.min(endS, out(z.endMs))),
			label: `zoom ${DEPTH_SCALES[z.depth]}x (${z.source ?? "auto"})`,
			kind: "zoom",
		});
	}
	for (const s of input.speedRegions ?? []) {
		marks.regions.push({ start: out(s.startMs), end: out(s.endMs), label: `${s.speed}x`, kind: "speed" });
	}

	for (const cap of input.captions) {
		const c = captionRect(cap.position ?? input.look.captionPosition);
		const start = out(cap.startMs);
		marks.spans.push({
			start,
			end: Math.max(start, Math.min(endS, out(cap.endMs))),
			label: cap.text,
			kind: "caption",
			x: c.x / 100,
			y: c.y / 100,
			w: c.width / 100,
			h: c.height / 100,
		});
	}
	marks.points.sort((a, b) => a.t - b.t);
	marks.regions.sort((a, b) => a.start - b.start);
	marks.spans.sort((a, b) => a.start - b.start);
	return marks;
}
