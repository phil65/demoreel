import { describe, expect, it } from "vitest";
import { boxToStage, stageLayout, toStage, zoomRect } from "../src/layout.ts";
import { buildCursorData, buildProject, DEFAULT_LOOK, normalizeSamples } from "../src/project.ts";
import { validateProject } from "../src/render.ts";
import type { CursorSample } from "../src/types.ts";

describe("normalizeSamples (cursor telemetry)", () => {
	it("sorts, clamps, rounds and fills defaults", () => {
		const samples: CursorSample[] = [
			{ timeMs: 20.04, cx: 1.2, cy: -0.1 },
			{ timeMs: 10, cx: 0.123456, cy: 0.5, interactionType: "click" },
			{ timeMs: Number.NaN, cx: 0.5, cy: 0.5 },
			{ timeMs: -5, cx: Number.NaN, cy: 0.2 },
		];
		const out = normalizeSamples(samples);
		expect(out.map((s) => s.timeMs)).toEqual([0, 10, 20]);
		expect(out[0]).toEqual({ timeMs: 0, cx: 0.5, cy: 0.2, assetId: null, visible: true, cursorType: "arrow", interactionType: "move" });
		expect(out[1].cx).toBe(0.1235);
		expect(out[1].interactionType).toBe("click");
		expect(out[2]).toMatchObject({ cx: 1, cy: 0 });
	});

	it("drops consecutive duplicate moves but keeps clicks", () => {
		const out = normalizeSamples([
			{ timeMs: 10, cx: 0.5, cy: 0.5 },
			{ timeMs: 10.2, cx: 0.5, cy: 0.5 },
			{ timeMs: 10.3, cx: 0.5, cy: 0.5, interactionType: "click" },
			{ timeMs: 10.4, cx: 0.5, cy: 0.5, interactionType: "mouseup" },
			{ timeMs: 500, cx: 0.5, cy: 0.5 },
		]);
		expect(out.map((s) => s.interactionType)).toEqual(["move", "click", "mouseup", "move"]);
	});

	it("keeps sample order for equal timestamps (click before mouseup)", () => {
		const out = normalizeSamples([
			{ timeMs: 5, cx: 0.1, cy: 0.1, interactionType: "click" },
			{ timeMs: 5, cx: 0.1, cy: 0.1, interactionType: "mouseup" },
		]);
		expect(out.map((s) => s.interactionType)).toEqual(["click", "mouseup"]);
	});

	it("buildCursorData wraps samples in OpenScreen's telemetry v2 envelope", () => {
		const d = buildCursorData([{ timeMs: 1, cx: 0.5, cy: 0.5 }]);
		expect(d).toMatchObject({ version: 2, provider: "none", assets: [] });
		expect(d.samples).toHaveLength(1);
	});
});

describe("buildProject + OpenScreen validation", () => {
	const project = buildProject({
		videoPath: "/tmp/demoreel-test/recording.mp4",
		zoomRegions: [{ id: "zoom-1", startMs: 100, endMs: 2000, depth: 2, focus: { cx: 0.4, cy: 0.5 }, focusMode: "manual", source: "auto" }],
		captions: [{ text: "Hello", startMs: 0, endMs: 1500 }],
		trimRegions: [{ id: "trim-1", startMs: 3000, endMs: 4000 }],
		speedRegions: [{ id: "speed-1", startMs: 5000, endMs: 6000, speed: 3 }],
	});

	it("passes OpenScreen's validateProjectData", async () => {
		const v = await validateProject(project as unknown as Record<string, unknown>);
		expect(v.valid).toBe(true);
	});

	it("survives normalizeProjectEditor unchanged (we write what OpenScreen would keep)", async () => {
		const v = await validateProject(project as unknown as Record<string, unknown>);
		expect(v.changedByNormalize).toEqual([]);
		expect(v.media).toMatchObject({ screenVideoPath: "/tmp/demoreel-test/recording.mp4" });
	});

	it("rejects garbage", async () => {
		expect((await validateProject({ version: 2 })).valid).toBe(false);
		expect((await validateProject({ hello: 1 })).valid).toBe(false);
	});

	it("applies look options and caption position", () => {
		const p = buildProject({ videoPath: "/x.mp4", zoomRegions: [], captions: [{ text: "t", startMs: 0, endMs: 1 }], look: { padding: 10, captionPosition: "top" } });
		expect(p.editor.padding).toBe(10);
		expect(p.editor.annotationRegions[0].position.y).toBe(3.5);
		expect(p.editor.wallpaper).toBe(DEFAULT_LOOK.wallpaper);
	});
});

describe("stage layout", () => {
	const vp = { width: 1920, height: 1080 };
	it("padding 40 puts a 16:9 recording on 84% of a 16:9 canvas", () => {
		const l = stageLayout(vp, { padding: 40, aspectRatio: "16:9" });
		expect(l.video.w).toBeCloseTo(0.84);
		expect(l.video.h).toBeCloseTo(0.84);
		expect(l.video.x).toBeCloseTo(0.08);
		expect(toStage(l, vp, { x: 960, y: 540 })).toEqual({ x: 0.5, y: 0.5 });
	});
	it("letterboxes into other aspect ratios", () => {
		const l = stageLayout(vp, { padding: 0, aspectRatio: "1:1" });
		expect(l.video.w).toBeCloseTo(1);
		expect(l.video.h).toBeCloseTo(9 / 16);
		expect(l.video.y).toBeCloseTo((1 - 9 / 16) / 2);
	});
	it("zoomRect scales around the focus", () => {
		const l = stageLayout(vp, { padding: 0, aspectRatio: "16:9" });
		const r = zoomRect(boxToStage(l, vp, { x: 960 - 96, y: 540 - 54, width: 192, height: 108 }), 2, { cx: 0.5, cy: 0.5 });
		expect(r.w).toBeCloseTo(0.15);
		expect(r.x + r.w / 2).toBeCloseTo(0.5);
	});
});
