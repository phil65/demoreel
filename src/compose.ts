/**
 * Turns a recording's timeline into the derived outputs: zoom regions, idle trims, the
 * OpenScreen project and framesheet marks. Used by `recordScenario` and `demoreel rezoom`
 * (which re-runs it from timeline.json without recording again).
 */
import fs from "node:fs";
import path from "node:path";
import { deriveIdleRegions, type IdleOptions, sourceToOutputMs } from "./idle.ts";
import { stageLayout } from "./layout.ts";
import { buildMarks, type Marks, placeCaptions, targetRects } from "./marks.ts";
import { buildCursorData, buildProject, DEFAULT_LOOK, type LookOptions } from "./project.ts";
import type { ActionRecord, Caption, CursorSample, SpeedRegion, TrimRegion, Viewport, ZoomRegion } from "./types.ts";
import { deriveZoomRegions, type ZoomOptions } from "./zoom.ts";

export const TIMELINE_VERSION = 1;

/** `timeline.json`: the agent-facing record of a run. Times in ms of the recording. */
export interface Timeline {
	version: number;
	scenario: string;
	createdAt: string;
	durationMs: number;
	/** Duration of the rendered video (after trim / speed regions). */
	outputDurationMs: number;
	frameCount: number;
	viewport: Viewport;
	frameSize: Viewport;
	options: { zoom: Partial<ZoomOptions>; look: Partial<LookOptions>; trimIdle: Partial<IdleOptions> | false };
	actions: ActionRecord[];
	zoomRegions: ZoomRegion[];
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	captions: Caption[];
	timings: Record<string, number>;
	files: { recording: string; cursor: string; project: string; marks: string; video: string };
	/** Recording-clock times of captured frames (visual changes). */
	frameTimes: number[];
}

export interface ComposeInput {
	name: string;
	outDir: string;
	videoPath: string;
	durationMs: number;
	frameCount: number;
	viewport: Viewport;
	frameSize: Viewport;
	actions: ActionRecord[];
	captions: Caption[];
	samples: CursorSample[];
	frameTimes: number[];
	timings: Record<string, number>;
	zoom?: Partial<ZoomOptions>;
	look?: Partial<LookOptions>;
	trimIdle?: Partial<IdleOptions> | boolean;
}

export interface ComposeResult {
	timeline: Timeline;
	timelinePath: string;
	projectPath: string;
	marksPath: string;
	marks: Marks;
	project: ReturnType<typeof buildProject>;
}

export function compose(input: ComposeInput, opts: { keepProjectFrom?: string } = {}): ComposeResult {
	const look = { ...DEFAULT_LOOK, ...input.look };
	const layout = stageLayout(input.viewport, look);
	const zoomRegions = deriveZoomRegions(input.actions, input.viewport, input.durationMs, input.zoom, layout);
	const captions = placeCaptions(
		input.captions.map(({ position: _p, ...c }) => c),
		targetRects({ actions: input.actions, viewport: input.viewport, layout, zoomRegions }),
		look.captionPosition,
	);
	const idleOpts = input.trimIdle === true ? {} : input.trimIdle || null;
	const { trimRegions, speedRegions } = idleOpts
		? deriveIdleRegions(
				{
					durationMs: input.durationMs,
					actions: input.actions,
					captions: input.captions,
					samples: input.samples,
					zoomRegions,
					frameTimes: input.frameTimes,
				},
				idleOpts,
			)
		: { trimRegions: [], speedRegions: [] };

	const projectPath = path.join(input.outDir, `${input.name}.openscreen`);
	let project = buildProject({
		videoPath: input.videoPath,
		zoomRegions,
		captions,
		trimRegions,
		speedRegions,
		look,
	});
	if (opts.keepProjectFrom && fs.existsSync(opts.keepProjectFrom)) {
		// rezoom: keep edits made in OpenScreen, replace only the derived regions.
		const prev = JSON.parse(fs.readFileSync(opts.keepProjectFrom, "utf8"));
		project = {
			...prev,
			editor: { ...prev.editor, zoomRegions, trimRegions, speedRegions, annotationRegions: project.editor.annotationRegions },
		};
	}
	fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
	const cursorPath = `${input.videoPath}.cursor.json`;
	fs.writeFileSync(cursorPath, JSON.stringify(buildCursorData(input.samples)));

	const marks = buildMarks({
		viewport: input.viewport,
		durationMs: input.durationMs,
		actions: input.actions,
		captions,
		zoomRegions,
		trimRegions,
		speedRegions,
		layout,
		look,
	});
	const marksPath = path.join(input.outDir, "marks.json");
	fs.writeFileSync(marksPath, JSON.stringify(marks, null, 1));

	const timeline: Timeline = {
		version: TIMELINE_VERSION,
		scenario: input.name,
		createdAt: new Date().toISOString(),
		durationMs: Math.round(input.durationMs),
		outputDurationMs: Math.round(sourceToOutputMs(input.durationMs, trimRegions, speedRegions)),
		frameCount: input.frameCount,
		viewport: input.viewport,
		frameSize: input.frameSize,
		options: {
			zoom: input.zoom ?? {},
			look: input.look ?? {},
			trimIdle: idleOpts ?? false,
		},
		actions: input.actions.map(roundAction),
		zoomRegions,
		trimRegions,
		speedRegions,
		captions: captions.map((c) => ({ ...c, startMs: Math.round(c.startMs), endMs: Math.round(c.endMs) })),
		timings: input.timings,
		files: {
			recording: path.basename(input.videoPath),
			cursor: path.basename(cursorPath),
			project: path.basename(projectPath),
			marks: path.basename(marksPath),
			video: `${input.name}.mp4`,
		},
		frameTimes: input.frameTimes,
	};
	const timelinePath = path.join(input.outDir, "timeline.json");
	fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 1));
	return { timeline, timelinePath, projectPath, marksPath, marks, project };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function roundAction(a: ActionRecord): ActionRecord {
	const box = (b?: { x: number; y: number; width: number; height: number }) =>
		b && { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) };
	return {
		...a,
		startMs: Math.round(a.startMs),
		arriveMs: Math.round(a.arriveMs),
		endMs: Math.round(a.endMs),
		...(a.box ? { box: box(a.box) } : {}),
		...(a.zoomBox ? { zoomBox: box(a.zoomBox) } : {}),
		...(a.point ? { point: { x: r1(a.point.x), y: r1(a.point.y) } } : {}),
	};
}

export function readTimeline(dir: string): Timeline {
	const p = path.join(dir, "timeline.json");
	if (!fs.existsSync(p)) throw new Error(`${p} not found (run \`demoreel run\` first)`);
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Re-derives zoom / idle regions, project and marks from an output dir's timeline.json. */
export function rezoom(
	dir: string,
	overrides: { zoom?: Partial<ZoomOptions>; trimIdle?: Partial<IdleOptions> | boolean; look?: Partial<LookOptions> } = {},
): ComposeResult {
	const tl = readTimeline(dir);
	const recording = path.join(dir, tl.files?.recording ?? "recording.mp4");
	const cursorFile = `${recording}.cursor.json`;
	const samples: CursorSample[] = fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")).samples : [];
	const trimIdle =
		overrides.trimIdle === undefined
			? tl.options?.trimIdle
			: overrides.trimIdle === true
				? { ...(tl.options?.trimIdle || {}) }
				: overrides.trimIdle;
	const projectPath = path.join(dir, `${tl.scenario}.openscreen`);
	return compose(
		{
			name: tl.scenario,
			outDir: dir,
			videoPath: recording,
			durationMs: tl.durationMs,
			frameCount: tl.frameCount,
			viewport: tl.viewport,
			frameSize: tl.frameSize,
			actions: tl.actions,
			captions: tl.captions,
			samples,
			frameTimes: tl.frameTimes ?? [],
			timings: tl.timings,
			zoom: { ...tl.options?.zoom, ...overrides.zoom },
			look: { ...tl.options?.look, ...overrides.look },
			trimIdle: trimIdle ?? false,
		},
		{ keepProjectFrom: overrides.look ? undefined : projectPath },
	);
}
