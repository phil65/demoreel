/** Shared data types. Times are milliseconds relative to the first recorded video frame. */

export interface Viewport {
	width: number;
	height: number;
}

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Mirrors OpenScreen's `CursorRecordingSample` (src/native/contracts.ts). */
export interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	visible?: boolean;
	cursorType?: "arrow" | "pointer" | "text" | null;
	interactionType?: "move" | "click" | "mouseup";
	assetId?: string | null;
}

export type ActionKind = "goto" | "click" | "type" | "hover" | "scroll" | "pause" | "caption" | "press";

/** One scripted step, as it actually happened during recording. */
export interface ActionRecord {
	kind: ActionKind;
	/** When the action (including cursor travel) started. */
	startMs: number;
	/** When the cursor arrived on the target (== startMs for actions without travel). */
	arriveMs: number;
	/** When the action finished (typing done, click released, ...). */
	endMs: number;
	/** Target bounding box in CSS px of the viewport, if the action had a target. */
	box?: Box;
	/** Action wants a zoom (default: click/type yes, hover opt-in). */
	zoom?: boolean | ZoomHint;
	label?: string;
	text?: string;
}

export interface ZoomHint {
	/** Force a depth (1..6) instead of deriving it from the element size. */
	depth?: 1 | 2 | 3 | 4 | 5 | 6;
	/** Extra context around the element, as a fraction of its size (default 1.2 => element ~45% of view). */
	context?: number;
}

export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth: 1 | 2 | 3 | 4 | 5 | 6;
	focus: { cx: number; cy: number };
	focusMode?: "manual" | "auto";
	source?: "auto" | "manual";
}

export interface Caption {
	text: string;
	startMs: number;
	endMs: number;
}

export interface RecordingResult {
	videoPath: string;
	durationMs: number;
	/** Recorded frame size in device pixels. */
	frameSize: Viewport;
	viewport: Viewport;
	samples: CursorSample[];
	actions: ActionRecord[];
	captions: Caption[];
	frameCount: number;
	timings: Record<string, number>;
}
