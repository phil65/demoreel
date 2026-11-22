/**
 * Node entry: OpenScreen's own project validation / normalisation and the zoom constants,
 * bundled by scripts/build-renderer.ts into dist/openscreen/project.js.
 */
export {
	normalizeProjectEditor,
	PROJECT_VERSION,
	resolveProjectMedia,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
export { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";
export {
	TRANSITION_WINDOW_MS,
	ZOOM_IN_TRANSITION_WINDOW_MS,
} from "@/components/video-editor/videoPlayback/constants";
