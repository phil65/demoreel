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

export type Depth = 1 | 2 | 3 | 4 | 5 | 6;

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

export type ActionKind =
	| "goto"
	| "click"
	| "type"
	| "hover"
	| "scroll"
	| "pause"
	| "caption"
	| "press"
	| "move"
	| "zoom"
	| "highlight";

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
	/**
	 * Box to zoom onto instead of `box`: the closest ancestor with `data-demoreel-zoom`
	 * (zoom anchor), if any.
	 */
	zoomBox?: Box;
	/** Action wants a zoom (default: click/type yes, hover opt-in). */
	zoom?: boolean | ZoomHint;
	/** Cursor position (viewport px) when the action happened, e.g. the click point. */
	point?: { x: number; y: number };
	label?: string;
	text?: string;
}

export interface ZoomHint {
	/** Force a depth (1..6) instead of deriving it from the element size. */
	depth?: Depth;
	/** Extra context around the element, as a factor of its size (2 => zoom so 2x the box fits). */
	context?: number;
}

export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth: Depth;
	/** Stage-normalised focus point (0-1 of the output canvas, as OpenScreen expects). */
	focus: { cx: number; cy: number };
	focusMode?: "manual" | "auto";
	source?: "auto" | "manual";
}

export interface Caption {
	text: string;
	startMs: number;
	endMs: number;
	/** Resolved placement (set by demoreel when the look's captionPosition is "auto"). */
	position?: "top" | "bottom";
}

/** OpenScreen trim region: the range is cut from the output. */
export interface TrimRegion {
	id: string;
	startMs: number;
	endMs: number;
}

/** OpenScreen speed region: the range plays at `speed`. */
export interface SpeedRegion {
	id: string;
	startMs: number;
	endMs: number;
	speed: number;
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
	/** Recording-clock times (ms) of every captured screencast frame (= a visual change). */
	frameTimes: number[];
	frameCount: number;
	timings: Record<string, number>;
}
