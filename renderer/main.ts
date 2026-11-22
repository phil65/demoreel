/**
 * Browser entry for headless export, bundled by scripts/build-renderer.ts into dist/renderer/
 * and loaded by src/render.ts inside Playwright Chromium.
 * Mirrors what OpenScreen's VideoEditor.tsx does on "Export": project -> VideoExporterConfig.
 */
import {
	normalizeProjectEditor,
	resolveProjectMedia,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { calculateEffectiveSourceDimensions, calculateMp4ExportSettings, VideoExporter } from "@/lib/exporter";
import type { CursorRecordingData } from "@/native/contracts";
import { getAspectRatioValue, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";

export interface RenderRequest {
	project: unknown;
	cursorData: CursorRecordingData | null;
	videoUrl: string;
	frameRate?: number;
	quality?: "medium" | "good" | "source";
	cursor?: { size?: number; smoothing?: number; motionBlur?: number; clickBounce?: number; show?: boolean };
	previewWidth?: number;
	previewHeight?: number;
}

function status(text: string) {
	const el = document.getElementById("status");
	if (el) el.textContent = text;
}

async function probeVideo(url: string) {
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "metadata";
	video.src = url;
	await new Promise<void>((resolve, reject) => {
		video.onloadedmetadata = () => resolve();
		video.onerror = () => reject(new Error(`cannot load ${url}`));
	});
	return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
}

const api = {
	validate(project: unknown) {
		const valid = validateProjectData(project);
		const media = valid ? resolveProjectMedia(project as never) : null;
		const normalized = valid ? normalizeProjectEditor((project as { editor: never }).editor) : null;
		return { valid, media, normalized };
	},

	async render(req: RenderRequest) {
		const t0 = performance.now();
		if (!validateProjectData(req.project)) throw new Error("project failed OpenScreen validateProjectData()");
		const editor = normalizeProjectEditor((req.project as { editor: never }).editor);
		const src = await probeVideo(req.videoUrl);
		const eff = calculateEffectiveSourceDimensions(src.width, src.height, editor.cropRegion);
		const aspect =
			editor.aspectRatio === "native"
				? getNativeAspectRatioValue(src.width, src.height, editor.cropRegion)
				: getAspectRatioValue(editor.aspectRatio);
		const { width, height, bitrate } = calculateMp4ExportSettings({
			quality: req.quality ?? editor.exportQuality,
			sourceWidth: eff.width,
			sourceHeight: eff.height,
			aspectRatioValue: aspect,
		});
		const cursorData = req.cursorData;
		const samples = cursorData?.samples ?? [];
		const cursorTelemetry = samples.map((s) => ({ timeMs: s.timeMs, cx: s.cx, cy: s.cy, interactionType: s.interactionType }));
		const cursorClickTimestamps = samples.filter((s) => s.interactionType === "click").map((s) => s.timeMs);
		const c = req.cursor ?? {};
		let lastPct = -1;
		const exporter = new VideoExporter({
			videoUrl: req.videoUrl,
			width,
			height,
			frameRate: req.frameRate ?? 60,
			bitrate,
			codec: "avc1.640033",
			wallpaper: editor.wallpaper,
			zoomRegions: editor.zoomRegions,
			trimRegions: editor.trimRegions,
			speedRegions: editor.speedRegions,
			showShadow: editor.shadowIntensity > 0,
			shadowIntensity: editor.shadowIntensity,
			showBlur: editor.showBlur,
			motionBlurAmount: editor.motionBlurAmount,
			borderRadius: editor.borderRadius,
			padding: editor.padding,
			cropRegion: editor.cropRegion,
			cursorRecordingData: cursorData,
			cursorScale: c.show === false ? 0 : (c.size ?? 3),
			cursorSmoothing: c.smoothing ?? 0.67,
			cursorMotionBlur: c.motionBlur ?? 0.35,
			cursorClickBounce: c.clickBounce ?? 2.5,
			cursorClipToBounds: false,
			cursorTheme: editor.cursorTheme,
			annotationRegions: editor.annotationRegions,
			webcamLayoutPreset: editor.webcamLayoutPreset,
			webcamMaskShape: editor.webcamMaskShape,
			webcamMirrored: editor.webcamMirrored,
			webcamReactiveZoom: editor.webcamReactiveZoom,
			webcamSizePreset: editor.webcamSizePreset,
			webcamPosition: editor.webcamPosition,
			previewWidth: req.previewWidth ?? 1280,
			previewHeight: req.previewHeight ?? 720,
			cursorTelemetry,
			cursorClickTimestamps,
			onProgress: (p) => {
				const pct = Math.floor(p.percentage);
				if (pct !== lastPct) {
					lastPct = pct;
					console.log(`[demoreel] progress ${pct}`);
				}
				status(`exporting ${pct}%`);
			},
		});
		const result = await exporter.export();
		if (!result.success || !result.blob) throw new Error(result.error ?? "export failed");
		const res = await fetch("/__demoreel/output", {
			method: "POST",
			body: result.blob,
		});
		if (!res.ok) throw new Error(`upload failed: ${res.status}`);
		return {
			width,
			height,
			bitrate,
			bytes: result.blob.size,
			warnings: result.warnings ?? [],
			renderMs: Math.round(performance.now() - t0),
			source: src,
		};
	},
};

(window as unknown as { demoreel: typeof api }).demoreel = api;
(window as unknown as { demoreelReady: boolean }).demoreelReady = true;
