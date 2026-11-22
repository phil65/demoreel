/**
 * Tiny static file server (node:http) with Range support. Serves a scenario's `serve`
 * directory during recording and the prebuilt renderer bundle (+ media / upload endpoints)
 * during rendering. Binds to 127.0.0.1 on a random port.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".txt": "text/plain; charset=utf-8",
};

export function contentType(file: string) {
	return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
	const size = fs.statSync(file).size;
	const type = contentType(file);
	const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : size - Number(range[2]);
		let end = range[1] && range[2] ? Number(range[2]) : size - 1;
		start = Math.max(0, start);
		end = Math.min(size - 1, end);
		if (start > end) {
			res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
			return;
		}
		res.writeHead(206, {
			"Content-Type": type,
			"Content-Range": `bytes ${start}-${end}/${size}`,
			"Accept-Ranges": "bytes",
			"Content-Length": end - start + 1,
		});
		if (req.method === "HEAD") return void res.end();
		fs.createReadStream(file, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
	if (req.method === "HEAD") return void res.end();
	fs.createReadStream(file).pipe(res);
}

/** Resolves a URL path inside `root`, or null if it escapes / does not exist. */
export function resolveInRoot(root: string, urlPath: string): string | null {
	let rel: string;
	try {
		rel = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
	if (file !== root && !file.startsWith(root + path.sep)) return null;
	if (!fs.existsSync(file)) return null;
	if (fs.statSync(file).isDirectory()) {
		const index = path.join(file, "index.html");
		return fs.existsSync(index) ? index : null;
	}
	return file;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean | Promise<boolean>;

export interface StaticServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

export function serveStatic(root: string | null, handlers: Handler[] = []): Promise<StaticServer> {
	const base = root ? path.resolve(root) : null;
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			for (const h of handlers) if (await h(req, res, url)) return;
			const file = base ? resolveInRoot(base, url.pathname) : null;
			if (!file) return void res.writeHead(404).end("not found");
			sendFile(req, res, file);
		} catch (e) {
			if (!res.headersSent) res.writeHead(500);
			res.end(String(e));
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				close: () =>
					new Promise<void>((r) => {
						server.closeAllConnections?.();
						server.close(() => r());
					}),
			});
		});
	});
}
