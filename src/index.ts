/** demoreel: scripted product demo videos (videos as code), rendered by OpenScreen's exporter. */
export { type Scenario, type ScenarioContext, type RecordOptions, type RecordResult, defineScenario, recordScenario } from "./record.ts";
export {
	type ActionOptions,
	applyZoomAnchor,
	DEFAULT_PACING,
	type HighlightOptions,
	type PacingOptions,
	Scene,
	type Target,
	ZOOM_ATTRIBUTE,
	type ZoomOptions as SceneZoomOptions,
} from "./scene.ts";
export { DEFAULT_ZOOM_OPTIONS, DEPTH_SCALES, deriveZoomRegions, depthForBox, type ZoomOptions } from "./zoom.ts";
export { DEFAULT_IDLE_OPTIONS, deriveIdleRegions, idleIntervals, type IdleOptions, sourceToOutputMs } from "./idle.ts";
export {
	buildCursorData,
	buildProject,
	type BuildProjectOptions,
	captionAnnotations,
	DEFAULT_LOOK,
	type LookOptions,
	normalizeSamples,
	type OpenScreenProject,
	writeProject,
} from "./project.ts";
export { buildMarks, type Marks, type MarkPoint, type MarkRegion, type MarkSpan, type MarksInput } from "./marks.ts";
export { stageLayout, type StageLayout } from "./layout.ts";
export { compose, rezoom, readTimeline, type Timeline, TIMELINE_VERSION } from "./compose.ts";
export { type CursorStyle, type RenderOptions, type RenderResult, renderProject, type ValidationResult, validateProject } from "./render.ts";
export { contactSheet, findFramesheet, reviewSheet, type SheetOptions, type SheetResult } from "./sheet.ts";
export { DemoreelError, detectGpu, type GpuMode, type GpuProbe } from "./env.ts";
export { loadScenario } from "./load.ts";
export type * from "./types.ts";
