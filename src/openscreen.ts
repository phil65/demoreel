/**
 * Access to the prebuilt OpenScreen bundles in `dist/` (built by `npm run build:renderer`
 * from the vendored, unmodified OpenScreen sources):
 *
 * - `dist/renderer/`: static browser app running OpenScreen's VideoExporter (headless export)
 * - `dist/openscreen/project.js`: OpenScreen's project validation/normalisation for Node
 *
 * Paths resolve relative to the package root, so this works from `src/` (dev) and `dist/`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DemoreelError } from "./env.ts";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RENDERER_DIR = path.join(PACKAGE_ROOT, "dist", "renderer");
export const PROJECT_BUNDLE = path.join(PACKAGE_ROOT, "dist", "openscreen", "project.js");

export interface OpenScreenProjectApi {
	PROJECT_VERSION: number;
	validateProjectData(candidate: unknown): boolean;
	normalizeProjectEditor(editor: unknown): Record<string, unknown>;
	resolveProjectMedia(project: unknown): unknown;
	ZOOM_DEPTH_SCALES: Record<number, number>;
	TRANSITION_WINDOW_MS: number;
	ZOOM_IN_TRANSITION_WINDOW_MS: number;
}

function missing(what: string): never {
	throw new DemoreelError(
		`demoreel's prebuilt OpenScreen bundle is missing (${what}).`,
		"in a git checkout run `npm run build:renderer`; from npm, reinstall demoreel",
	);
}

export function rendererDir(): string {
	if (!fs.existsSync(path.join(RENDERER_DIR, "index.html"))) missing(RENDERER_DIR);
	return RENDERER_DIR;
}

let api: Promise<OpenScreenProjectApi> | null = null;

export function openscreenProjectApi(): Promise<OpenScreenProjectApi> {
	api ??= (async () => {
		if (!fs.existsSync(PROJECT_BUNDLE)) missing(PROJECT_BUNDLE);
		return (await import(pathToFileURL(PROJECT_BUNDLE).href)) as OpenScreenProjectApi;
	})();
	return api;
}
