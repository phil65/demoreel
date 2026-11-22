/**
 * "Trim idle": finds stretches where nothing happens (no action in progress, no cursor
 * motion, no caption, no zoom transition, no burst of visual change) and cuts them down
 * with OpenScreen trim regions, or speeds them up with speed regions.
 * Also maps recording times to output times through those regions.
 */
import type { ActionRecord, Caption, CursorSample, SpeedRegion, TrimRegion, ZoomRegion } from "./types.ts";

export interface IdleOptions {
	/** Idle stretches shorter than this are left alone. */
	minMs: number;
	/** How much of each idle stretch to keep (split evenly before/after the cut). */
	keepMs: number;
	/** `trim` cuts the stretch, `speed` plays it faster. */
	mode: "trim" | "speed";
	/** Playback speed for `mode: "speed"` (OpenScreen allows 0.1-16). */
	speed: number;
}

export const DEFAULT_IDLE_OPTIONS: IdleOptions = { minMs: 1200, keepMs: 600, mode: "trim", speed: 3 };

/** OpenScreen zoom envelope (constants.ts TRANSITION_WINDOW_MS / ZOOM_IN_TRANSITION_WINDOW_MS). */
const ZOOM_IN_BEFORE_MS = 1022;
const ZOOM_IN_AFTER_MS = 500;
const ZOOM_OUT_AFTER_MS = 1016;

type Interval = [number, number];

function mergeIntervals(list: Interval[]): Interval[] {
	const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	const out: Interval[] = [];
	for (const iv of sorted) {
		const last = out[out.length - 1];
		if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
		else out.push([iv[0], iv[1]]);
	}
	return out;
}

export interface IdleInput {
	durationMs: number;
	actions: ActionRecord[];
	captions: Caption[];
	samples: CursorSample[];
	zoomRegions: ZoomRegion[];
	/** Screencast frame times; bursts of frames (animation, page load) count as activity. */
	frameTimes?: number[];
}

/** Busy intervals of a recording (anything a viewer should see at normal speed). */
export function busyIntervals(input: IdleInput): Interval[] {
	const busy: Interval[] = [];
	for (const a of input.actions) {
		if (a.kind === "pause" || a.kind === "caption") continue;
		busy.push([a.startMs - 150, a.endMs + 250]);
	}
	for (const c of input.captions) busy.push([c.startMs - 200, c.endMs + 200]);
	for (const z of input.zoomRegions) {
		busy.push([z.startMs - ZOOM_IN_BEFORE_MS, z.startMs + ZOOM_IN_AFTER_MS]);
		busy.push([z.endMs - 100, z.endMs + ZOOM_OUT_AFTER_MS]);
	}
	const s = input.samples;
	for (let i = 1; i < s.length; i++) {
		const moved = Math.abs(s[i].cx - s[i - 1].cx) + Math.abs(s[i].cy - s[i - 1].cy) > 1e-4;
		if (moved || s[i].interactionType !== "move") busy.push([s[i - 1].timeMs - 100, s[i].timeMs + 150]);
	}
	// >= 3 frames within 300 ms: something animates or paints.
	const f = input.frameTimes ?? [];
	for (let i = 2; i < f.length; i++) {
		if (f[i] - f[i - 2] <= 300) busy.push([f[i - 2] - 100, f[i] + 200]);
	}
	return mergeIntervals(busy);
}

/** Idle stretches (complement of the busy intervals) longer than `minMs`. */
export function idleIntervals(input: IdleInput, minMs = DEFAULT_IDLE_OPTIONS.minMs): Interval[] {
	const busy = busyIntervals(input);
	const out: Interval[] = [];
	let cursor = 0;
	for (const [a, b] of busy) {
		if (a - cursor >= minMs) out.push([cursor, a]);
		cursor = Math.max(cursor, b);
	}
	if (input.durationMs - cursor >= minMs) out.push([cursor, input.durationMs]);
	return out;
}

export function deriveIdleRegions(
	input: IdleInput,
	partial: Partial<IdleOptions> = {},
): { trimRegions: TrimRegion[]; speedRegions: SpeedRegion[] } {
	const opts = { ...DEFAULT_IDLE_OPTIONS, ...partial };
	const half = opts.keepMs / 2;
	const cuts = idleIntervals(input, Math.max(opts.minMs, opts.keepMs + 100))
		// keep the final hold (zoom-out, last frame) a bit longer than other stretches
		.map(([a, b]) => [Math.round(a + half), Math.round(b - (b >= input.durationMs ? Math.max(half, 900) : half))] as Interval)
		.filter(([a, b]) => b - a >= 100);
	if (opts.mode === "speed") {
		const speed = Math.round(Math.min(16, Math.max(0.1, opts.speed)) * 100) / 100;
		return {
			trimRegions: [],
			speedRegions: cuts.map(([a, b], i) => ({ id: `speed-${i + 1}`, startMs: a, endMs: b, speed })),
		};
	}
	return {
		trimRegions: cuts.map(([a, b], i) => ({ id: `trim-${i + 1}`, startMs: a, endMs: b })),
		speedRegions: [],
	};
}

/**
 * Maps a recording time (ms) to the rendered output's time (ms) through trim and speed
 * regions. Times inside a trimmed range map to the cut point.
 */
export function sourceToOutputMs(t: number, trims: TrimRegion[] = [], speeds: SpeedRegion[] = []): number {
	let out = t;
	for (const r of trims) {
		if (t >= r.endMs) out -= r.endMs - r.startMs;
		else if (t > r.startMs) out -= t - r.startMs;
	}
	for (const r of speeds) {
		// Overlap with trims is not modelled (demoreel never writes both).
		const covered = Math.max(0, Math.min(t, r.endMs) - r.startMs);
		out -= covered - covered / r.speed;
	}
	return out;
}
