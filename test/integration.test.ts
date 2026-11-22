/**
 * Records a ~3 s 640x360 scenario against the bundled demo app and renders it with OpenScreen's
 * exporter (quality "source" => 640x360 output, 30 fps). Opt-in: DEMOREEL_INTEGRATION=1.
 * DEMOREEL_RENDER=0 skips the render step (e.g. on slow software-GL machines).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rezoom } from "../src/compose.ts";
import { loadScenario } from "../src/load.ts";
import { recordScenario } from "../src/record.ts";
import { renderProject, validateProject } from "../src/render.ts";
import { probeDuration } from "../src/sheet.ts";

const enabled = process.env.DEMOREEL_INTEGRATION === "1";
const render = process.env.DEMOREEL_RENDER !== "0";

describe.skipIf(!enabled)("integration: record + render", () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "demoreel-it-"));
	const file = path.join(import.meta.dirname, "fixtures/tiny.scenario.ts");

	it("records a scenario and writes project, timeline and marks", async () => {
		const scenario = await loadScenario(file);
		const rec = await recordScenario(scenario, { outDir: out, scenarioFile: file });
		expect(rec.result.frameSize).toEqual({ width: 640, height: 360 });
		expect(rec.result.durationMs).toBeGreaterThan(1500);
		expect(rec.result.actions.map((a) => a.kind)).toEqual(expect.arrayContaining(["type", "click", "highlight"]));
		expect(rec.timeline.zoomRegions.length).toBeGreaterThan(0);
		expect(rec.marks.points.some((p) => p.kind === "click")).toBe(true);
		expect(rec.marks.spans[0]).toMatchObject({ label: "Tiny demo", kind: "caption" });
		const v = await validateProject(rec.projectPath);
		expect(v.valid).toBe(true);
		expect(v.changedByNormalize).toEqual([]);
		const dur = await probeDuration(rec.result.videoPath);
		expect(dur).toBeGreaterThan(1.5);
	}, 120_000);

	it("rezooms from timeline.json without re-recording", () => {
		const res = rezoom(out, { zoom: { maxDepth: 1 }, trimIdle: true });
		expect(res.timeline.zoomRegions[0].depth).toBe(1);
		// the click with an explicit depth hint keeps it
		expect(res.timeline.zoomRegions.some((z) => z.depth === 3)).toBe(true);
		expect(res.timeline.options.zoom).toMatchObject({ maxDepth: 1 });
	});

	it.skipIf(!render)(
		"renders the project with OpenScreen's exporter",
		async () => {
			const projectPath = path.join(out, "tiny.openscreen");
			const r = await renderProject({ projectPath, quality: "source", frameRate: 30, log: () => {} });
			expect(r.width).toBe(640);
			expect(r.height).toBe(360);
			expect(fs.statSync(r.outputPath).size).toBeGreaterThan(10_000);
			const dur = await probeDuration(r.outputPath);
			expect(dur).toBeGreaterThan(1);

			// marks.json is in output coordinates: the "add task" target box must sit on the
			// (accent-coloured, #5b5bd6) button in the rendered, zoomed frame.
			const marks = JSON.parse(fs.readFileSync(path.join(out, "marks.json"), "utf8"));
			const target = marks.regions.find((m: { kind: string; label: string }) => m.kind === "target" && m.label === "click add task");
			expect(target).toBeTruthy();
			const t = (target.start + target.end) / 2;
			const frame = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", r.outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
			expect(frame.status).toBe(0);
			const px = (fx: number, fy: number) => {
				const i = (Math.round(fy * 360) * 640 + Math.round(fx * 640)) * 3;
				return [...frame.stdout.subarray(i, i + 3)];
			};
			const isAccent = ([r_, g, b]: number[]) => Math.abs(r_ - 0x5b) < 40 && Math.abs(g - 0x5b) < 40 && Math.abs(b - 0xd6) < 40;
			for (const fx of [0.12, 0.88]) {
				expect(isAccent(px(target.x + target.w * fx, target.y + target.h * 0.5))).toBe(true);
			}
			// ... and just outside the box it is not the button any more
			expect(isAccent(px(target.x + target.w * 0.5, Math.max(0, target.y - target.h * 0.6)))).toBe(false);
			const click = marks.points.find((p: { kind: string }) => p.kind === "click");
			expect(click.x).toBeGreaterThan(target.x);
			expect(click.x).toBeLessThan(target.x + target.w);
			expect(click.y).toBeGreaterThan(target.y);
			expect(click.y).toBeLessThan(target.y + target.h);
		},
		600_000,
	);
});
