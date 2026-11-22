import { describe, expect, it } from "vitest";
import { stageLayout } from "../src/layout.ts";
import { openscreenProjectApi } from "../src/openscreen.ts";
import { applyZoomAnchor } from "../src/scene.ts";
import type { ActionRecord } from "../src/types.ts";
import { clampFocusToVideo, DEFAULT_ZOOM_OPTIONS, DEPTH_SCALES, depthForBox, deriveZoomRegions } from "../src/zoom.ts";

const vp = { width: 1920, height: 1080 };
const noPad = stageLayout(vp, { padding: 0, aspectRatio: "16:9" });

function click(at: number, box: ActionRecord["box"], extra: Partial<ActionRecord> = {}): ActionRecord {
	return { kind: "click", startMs: at - 400, arriveMs: at, endMs: at + 150, box, zoom: true, ...extra };
}

describe("OpenScreen constants", () => {
	it("DEPTH_SCALES matches OpenScreen's ZOOM_DEPTH_SCALES", async () => {
		const os = await openscreenProjectApi();
		expect(DEPTH_SCALES).toEqual(os.ZOOM_DEPTH_SCALES);
	});
	it("zoom envelope constants are the ones demoreel's timing assumes", async () => {
		const os = await openscreenProjectApi();
		expect(Math.round(os.TRANSITION_WINDOW_MS)).toBe(1015);
		expect(Math.round(os.ZOOM_IN_TRANSITION_WINDOW_MS)).toBe(1523);
	});
});

describe("depthForBox", () => {
	it("zooms small elements up to maxDepth", () => {
		expect(depthForBox({ x: 0, y: 0, width: 100, height: 30 }, vp)).toBe(DEFAULT_ZOOM_OPTIONS.maxDepth);
	});
	it("zooms less for big elements and not at all for huge ones", () => {
		expect(depthForBox({ x: 0, y: 0, width: 1100, height: 300 }, vp)).toBe(1);
		expect(depthForBox({ x: 0, y: 0, width: 1800, height: 900 }, vp)).toBeNull();
	});
	it("honours hints", () => {
		expect(depthForBox({ x: 0, y: 0, width: 1800, height: 900 }, vp, DEFAULT_ZOOM_OPTIONS, { depth: 5 })).toBe(5);
		const big = depthForBox({ x: 0, y: 0, width: 400, height: 120 }, vp, DEFAULT_ZOOM_OPTIONS, { context: 3 });
		const small = depthForBox({ x: 0, y: 0, width: 400, height: 120 }, vp);
		expect(big).not.toBeNull();
		expect(big as number).toBeLessThan(small as number);
	});
	it("accounts for padding (the recording covers less of the stage)", () => {
		const box = { x: 0, y: 0, width: 600, height: 200 };
		const plain = depthForBox(box, vp, { ...DEFAULT_ZOOM_OPTIONS, maxDepth: 6 });
		const padded = depthForBox(box, vp, { ...DEFAULT_ZOOM_OPTIONS, maxDepth: 6 }, undefined, { w: 0.84, h: 0.84 });
		expect(padded as number).toBeGreaterThanOrEqual(plain as number);
	});
});

describe("deriveZoomRegions", () => {
	it("creates one region per isolated action with lead and hold", () => {
		const [r] = deriveZoomRegions([click(2000, { x: 900, y: 500, width: 120, height: 40 })], vp, 10_000, {}, noPad);
		expect(r.startMs).toBe(2000 - DEFAULT_ZOOM_OPTIONS.leadMs);
		expect(r.endMs).toBe(2150 + DEFAULT_ZOOM_OPTIONS.holdMs);
		expect(r.source).toBe("auto");
		expect(r.focus.cx).toBeCloseTo(960 / 1920, 3);
		expect(r.focus.cy).toBeCloseTo(520 / 1080, 3);
	});

	it("merges nearby actions whose union still zooms", () => {
		const regions = deriveZoomRegions(
			[click(2000, { x: 400, y: 300, width: 200, height: 36 }), click(3000, { x: 400, y: 360, width: 200, height: 36 })],
			vp,
			10_000,
			{},
			noPad,
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].endMs).toBe(3150 + DEFAULT_ZOOM_OPTIONS.holdMs);
	});

	it("chains (pans) between nearby actions far apart on screen", () => {
		const regions = deriveZoomRegions(
			[click(2000, { x: 100, y: 100, width: 60, height: 30 }), click(3000, { x: 1700, y: 950, width: 60, height: 30 })],
			vp,
			10_000,
			{},
			noPad,
		);
		expect(regions).toHaveLength(2);
		expect(regions[0].endMs).toBeLessThan(regions[1].startMs);
	});

	it("ends a zoom before a scroll or navigation", () => {
		const regions = deriveZoomRegions(
			[click(2000, { x: 900, y: 500, width: 120, height: 40 }), { kind: "scroll", startMs: 2400, arriveMs: 2400, endMs: 3000 }],
			vp,
			10_000,
			{},
			noPad,
		);
		expect(regions[0].endMs).toBe(2400 - 150);
	});

	it("skips actions with zoom: false and uses data-demoreel-zoom anchor boxes", () => {
		const anchor = { x: 560, y: 340, width: 800, height: 400 };
		const regions = deriveZoomRegions(
			[
				click(2000, { x: 900, y: 500, width: 120, height: 40 }, { zoom: false }),
				click(6000, { x: 600, y: 360, width: 50, height: 20 }, { zoomBox: anchor }),
			],
			vp,
			10_000,
			{},
			noPad,
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].focus).toEqual({ cx: 0.5, cy: 0.5 });
		expect(regions[0].depth).toBe(depthForBox(anchor, vp));
	});

	it("explicit scene.zoom() regions override automatic ones", () => {
		const regions = deriveZoomRegions(
			[
				{ kind: "zoom", startMs: 1000, arriveMs: 1000, endMs: 4000, box: { x: 0, y: 0, width: 400, height: 200 }, zoom: { depth: 4 } },
				click(2500, { x: 1500, y: 800, width: 100, height: 40 }),
			],
			vp,
			10_000,
			{},
			noPad,
		);
		const manual = regions.filter((r) => r.source === "manual");
		expect(manual).toHaveLength(1);
		expect(manual[0]).toMatchObject({ startMs: 1000, endMs: 4000, depth: 4 });
		for (const r of regions.filter((x) => x.source === "auto")) {
			expect(r.endMs <= 1000 || r.startMs >= 4000).toBe(true);
		}
	});

	it("auto: false keeps only explicit zooms", () => {
		const regions = deriveZoomRegions([click(2000, { x: 900, y: 500, width: 120, height: 40 })], vp, 10_000, { auto: false });
		expect(regions).toEqual([]);
	});

	it("clips to the recording and drops too-short regions", () => {
		const regions = deriveZoomRegions([click(100, { x: 900, y: 500, width: 120, height: 40 })], vp, 600, {}, noPad);
		expect(regions[0].startMs).toBe(0);
		expect(regions[0].endMs).toBe(600);
		expect(deriveZoomRegions([click(100, { x: 900, y: 500, width: 120, height: 40 })], vp, 200, {}, noPad)).toEqual([]);
	});

	it("maps focus into stage coordinates and keeps the view inside the recording", () => {
		const layout = stageLayout(vp, { padding: 40, aspectRatio: "16:9" });
		const [r] = deriveZoomRegions([click(2000, { x: 0, y: 0, width: 40, height: 20 })], vp, 10_000, {}, layout);
		const half = 0.5 / DEPTH_SCALES[r.depth];
		expect(r.focus.cx).toBeCloseTo(layout.video.x + half, 3);
		expect(r.focus.cy).toBeCloseTo(layout.video.y + half, 3);
		const [free] = deriveZoomRegions([click(2000, { x: 0, y: 0, width: 40, height: 20 })], vp, 10_000, { clampToVideo: false }, layout);
		expect(free.focus.cx).toBeCloseTo(layout.video.x + (20 / 1920) * layout.video.w, 3);
	});
});

describe("clampFocusToVideo", () => {
	it("centres when the view is larger than the recording", () => {
		const layout = stageLayout(vp, { padding: 100, aspectRatio: "16:9" });
		expect(clampFocusToVideo({ cx: 0.1, cy: 0.9 }, 1, layout)).toEqual({ cx: 0.5, cy: 0.5 });
	});
});

describe("applyZoomAnchor", () => {
	it("parses data-demoreel-zoom values", () => {
		expect(applyZoomAnchor(true, undefined)).toBe(true);
		expect(applyZoomAnchor(true, { value: "" })).toBe(true);
		expect(applyZoomAnchor(true, { value: "off" })).toBe(false);
		expect(applyZoomAnchor(false, { value: "3" })).toBe(false);
		expect(applyZoomAnchor(true, { value: "3" })).toEqual({ depth: 3 });
		expect(applyZoomAnchor({ context: 2 }, { value: "2" })).toEqual({ context: 2, depth: 2 });
	});
});
