/**
 * Headless export: serves renderer/ (which imports OpenScreen's VideoExporter from
 * vendor/openscreen) with Vite, opens it in headless Chromium via Playwright and lets
 * OpenScreen's own WebCodecs + Pixi pipeline render the MP4.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
const VENDOR = path.join(ROOT, "vendor/openscreen");

export interface RenderOptions {
	projectPath: string;
	outputPath: string;
	frameRate?: number;
	quality?: "medium" | "good" | "source";
	cursor?: { size?: number; smoothing?: number; motionBlur?: number; clickBounce?: number; show?: boolean };
	/** Use a GPU-backed GL instead of SwiftShader (faster where available). */
	gpu?: boolean;
	verbose?: boolean;
}

function mediaPlugin(files: Map<string, string>, outputs: Set<string>): Plugin {
	const wasm = path.join(ROOT, "node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm");
	const serveFile = (req: IncomingMessage, res: ServerResponse, file: string, type: string) => {
		const size = fs.statSync(file).size;
		const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
		if (range) {
			const start = range[1] ? Number(range[1]) : 0;
			const end = range[2] ? Number(range[2]) : size - 1;
			res.writeHead(206, {
				"Content-Type": type,
				"Content-Range": `bytes ${start}-${end}/${size}`,
				"Accept-Ranges": "bytes",
				"Content-Length": end - start + 1,
			});
			fs.createReadStream(file, { start, end }).pipe(res);
		} else {
			res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
			fs.createReadStream(file).pipe(res);
		}
	};
	return {
		name: "demoreel-media",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = new URL(req.url ?? "/", "http://x");
				if (url.pathname.endsWith("/wasm/web-demuxer.wasm")) return serveFile(req, res, wasm, "application/wasm");
				if (url.pathname.startsWith("/__demoreel/media/")) {
					const file = files.get(url.pathname);
					if (!file) return void res.writeHead(404).end();
					return serveFile(req, res, file, file.endsWith(".mp4") ? "video/mp4" : "video/webm");
				}
				if (url.pathname === "/__demoreel/output" && req.method === "POST") {
					const target = url.searchParams.get("path") ?? "";
					if (!outputs.has(target)) return void res.writeHead(403).end();
					const out = fs.createWriteStream(target);
					req.pipe(out);
					out.on("finish", () => res.writeHead(200).end("ok"));
					return;
				}
				next();
			});
		},
	};
}

export async function startRendererServer(files: Map<string, string>, outputs: Set<string>): Promise<ViteDevServer> {
	const server = await createServer({
		configFile: false,
		root: path.join(ROOT, "renderer"),
		publicDir: path.join(VENDOR, "public"),
		logLevel: "warn",
		resolve: { alias: { "@": path.join(VENDOR, "src") } },
		server: { port: 0, host: "127.0.0.1", fs: { allow: [ROOT] } },
		plugins: [mediaPlugin(files, outputs)],
		optimizeDeps: { include: ["pixi.js", "pixi-filters/motion-blur", "mediabunny", "web-demuxer", "gif.js", "motion"] },
	});
	await server.listen();
	return server;
}

export async function renderProject(opts: RenderOptions) {
	const t0 = Date.now();
	const project = JSON.parse(fs.readFileSync(opts.projectPath, "utf8"));
	const videoPath: string = project.media?.screenVideoPath ?? project.videoPath;
	const cursorFile = `${videoPath}.cursor.json`;
	const cursorData = fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")) : null;
	const mediaUrl = `/__demoreel/media/0/${path.basename(videoPath)}`;
	const outputPath = path.resolve(opts.outputPath);
	const server = await startRendererServer(new Map([[mediaUrl, videoPath]]), new Set([outputPath]));
	const address = server.httpServer?.address();
	const port = typeof address === "object" && address ? address.port : 5173;
	const browser = await chromium.launch({
		headless: true,
		args: opts.gpu
			? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan"]
			: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
	});
	try {
		const page = await browser.newPage();
		page.on("console", (m) => {
			const t = m.text();
			if (opts.verbose || t.startsWith("[demoreel]") || m.type() === "error") console.log(`  [browser] ${t}`);
		});
		page.on("pageerror", (e) => console.error("  [pageerror]", e.message));
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitForFunction(() => (window as unknown as { demoreelReady?: boolean }).demoreelReady, null, {
			timeout: 120_000,
		});
		const tReady = Date.now();
		const result = await page.evaluate(
			(req) => (window as any).demoreel.render(req),
			{
				project,
				cursorData,
				videoUrl: mediaUrl,
				outputPath,
				frameRate: opts.frameRate ?? 60,
				quality: opts.quality,
				cursor: opts.cursor,
			},
		);
		return { ...result, outputPath, setupMs: tReady - t0, totalMs: Date.now() - t0 };
	} finally {
		await browser.close();
		await server.close();
	}
}

/** Runs OpenScreen's own validateProjectData / normalizeProjectEditor on a project file. */
export async function validateProject(projectPath: string) {
	const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
	const server = await startRendererServer(new Map(), new Set());
	const address = server.httpServer?.address();
	const port = typeof address === "object" && address ? address.port : 5173;
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitForFunction(() => (window as any).demoreelReady, null, { timeout: 120_000 });
		const res = await page.evaluate((p) => (window as any).demoreel.validate(p), project);
		// Compare what we wrote with what OpenScreen would keep after normalisation.
		const diffs: string[] = [];
		if (res.valid) {
			for (const [k, v] of Object.entries(project.editor)) {
				if (JSON.stringify(v) !== JSON.stringify(res.normalized[k])) diffs.push(k);
			}
		}
		return { valid: res.valid as boolean, media: res.media, changedByNormalize: diffs };
	} finally {
		await browser.close();
		await server.close();
	}
}
