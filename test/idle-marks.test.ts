import fs from "node:fs";
import path from "node:path";
import AjvModule from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { deriveIdleRegions, idleIntervals, sourceToOutputMs } from "../src/idle.ts";
import { stageLayout } from "../src/layout.ts";
import { applyCamera, buildMarks, zoomProgress } from "../src/marks.ts";
import type { ActionRecord, ZoomRegion } from "../src/types.ts";

const vp = { width: 1920, height: 1080 };

describe("idle detection", () => {
	const base = { durationMs: 12_000, captions: [], samples: [], zoomRegions: [] as ZoomRegion[] };
	const actions: ActionRecord[] = [
		{ kind: "click", startMs: 500, arriveMs: 900, endMs: 1000, box: { x: 0, y: 0, width: 10, height: 10 } },
		{ kind: "pause", startMs: 1000, arriveMs: 1000, endMs: 6000 },
		{ kind: "click", startMs: 6000, arriveMs: 6400, endMs: 6500, box: { x: 0, y: 0, width: 10, height: 10 } },
	];

	it("finds stretches without activity", () => {
		const idle = idleIntervals({ ...base, actions });
		expect(idle[0][0]).toBeCloseTo(1250, -1);
		expect(idle[0][1]).toBeCloseTo(5850, -1);
		expect(idle.at(-1)?.[1]).toBe(12_000);
	});

	it("captions, frame bursts and zoom transitions count as activity", () => {
		const withCaption = idleIntervals({ ...base, actions, captions: [{ text: "x", startMs: 1500, endMs: 5500 }] });
		expect(withCaption[0][0]).toBeGreaterThan(5000);
		const frames = Array.from({ length: 30 }, (_, i) => 2000 + i * 50);
		const withFrames = idleIntervals({ ...base, actions, frameTimes: frames });
		expect(withFrames.some(([a, b]) => a < 2500 && b > 3000)).toBe(false);
		const zoomRegions: ZoomRegion[] = [{ id: "z", startMs: 4000, endMs: 4500, depth: 2, focus: { cx: 0.5, cy: 0.5 } }];
		const withZoom = idleIntervals({ ...base, actions, zoomRegions });
		expect(withZoom.some(([a, b]) => a < 3500 && b > 4500)).toBe(false);
	});

	it("trims idle stretches keeping keepMs, or speeds them up", () => {
		const { trimRegions } = deriveIdleRegions({ ...base, actions }, { keepMs: 600 });
		expect(trimRegions[0].endMs - trimRegions[0].startMs).toBeCloseTo(5850 - 1250 - 600, -1);
		const { speedRegions, trimRegions: none } = deriveIdleRegions({ ...base, actions }, { mode: "speed", speed: 4 });
		expect(none).toEqual([]);
		expect(speedRegions[0].speed).toBe(4);
	});

	it("maps source to output time", () => {
		const trims = [{ id: "t", startMs: 1000, endMs: 3000 }];
		expect(sourceToOutputMs(500, trims)).toBe(500);
		expect(sourceToOutputMs(2000, trims)).toBe(1000);
		expect(sourceToOutputMs(4000, trims)).toBe(2000);
		const speeds = [{ id: "s", startMs: 1000, endMs: 3000, speed: 4 }];
		expect(sourceToOutputMs(3000, [], speeds)).toBe(1500);
		expect(sourceToOutputMs(5000, [], speeds)).toBe(3500);
	});
});

describe("framesheet marks", () => {
	const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/framesheet-marks.schema.json"), "utf8"));
	const Ajv2020 = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => {
		compile(s: object): ((d: unknown) => boolean) & { errors?: unknown[] | null };
	};
	const validate = new Ajv2020({ strict: false }).compile(schema);
	const layout = stageLayout(vp, { padding: 40, aspectRatio: "16:9" });
	const zoomRegions: ZoomRegion[] = [{ id: "z", startMs: 1000, endMs: 3000, depth: 2, focus: { cx: 0.5, cy: 0.5 }, source: "auto" }];
	const actions: ActionRecord[] = [
		{ kind: "click", startMs: 1000, arriveMs: 1500, endMs: 1600, box: { x: 900, y: 500, width: 120, height: 80 }, point: { x: 960, y: 540 }, label: "save" },
		{ kind: "type", startMs: 4000, arriveMs: 4200, endMs: 5000, box: { x: 0, y: 0, width: 300, height: 40 }, point: { x: 10, y: 10 }, text: "hi" },
		{ kind: "highlight", startMs: 6000, arriveMs: 6000, endMs: 7000, box: { x: 1800, y: 1000, width: 200, height: 200 } },
	];
	const marks = buildMarks({
		viewport: vp,
		durationMs: 9000,
		actions,
		captions: [{ text: "Save it", startMs: 0, endMs: 2000 }],
		zoomRegions,
		trimRegions: [{ id: "t", startMs: 7500, endMs: 8500 }],
		layout,
		look: { captionPosition: "bottom" },
	});

	it("validates against framesheet's marks.schema.json", () => {
		const ok = validate(marks);
		expect(validate.errors ?? []).toEqual([]);
		expect(ok).toBe(true);
	});

	it("maps targets through padding and the zoom camera", () => {
		const target = marks.regions.find((r) => r.kind === "target" && r.label === "click save");
		// centred element under a centred 1.5x zoom: stays centred, 1.5x the padded size
		expect(target?.x! + target?.w! / 2).toBeCloseTo(0.5, 2);
		expect(target?.w).toBeCloseTo((120 / 1920) * 0.84 * 1.5, 3);
		const click = marks.points.find((p) => p.kind === "click");
		expect(click).toMatchObject({ x: 0.5, y: 0.5, t: 1.6 });
		const type = marks.points.find((p) => p.kind === "type");
		expect(type?.duration).toBeCloseTo(0.8);
	});

	it("clips boxes to the frame and has caption spans with boxes", () => {
		const hl = marks.regions.find((r) => r.kind === "highlight");
		expect(hl?.x! + hl?.w!).toBeLessThanOrEqual(1);
		expect(marks.spans[0]).toMatchObject({ label: "Save it", kind: "caption", x: 0.15, y: 0.885, w: 0.7, h: 0.08 });
		expect(marks.regions.find((r) => r.kind === "zoom")).toMatchObject({ start: 1, end: 3 });
	});

	it("zoom progress ramps in before the region and out after it", () => {
		const r = zoomRegions[0];
		expect(zoomProgress(r, -100)).toBe(0);
		expect(zoomProgress(r, 1600)).toBe(1);
		expect(zoomProgress(r, 2500)).toBe(1);
		expect(zoomProgress(r, 3500)).toBeGreaterThan(0);
		expect(zoomProgress(r, 3500)).toBeLessThan(1);
		expect(zoomProgress(r, 5000)).toBe(0);
		expect(applyCamera({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, zoomRegions, 2000)).toEqual({ x: 0.125, y: 0.125, w: 0.75, h: 0.75 });
	});
});
