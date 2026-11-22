/**
 * Scenario API on top of Playwright. Every method drives the real page and records what happened
 * (cursor samples on the recording clock, action boxes) so zoom regions and the cursor overlay can
 * be derived afterwards.
 */
import type { Locator, Page } from "playwright";
import { easeAimed, makePath, mulberry32, type Point, sleep, travelDuration } from "./motion";
import type { ScreencastRecorder } from "./recorder";
import type { ActionRecord, Box, Caption, CursorSample, Viewport, ZoomHint } from "./types";

export type Target = string | Locator;

export interface PacingOptions {
	/** Global speed multiplier (2 = twice as fast). */
	speed: number;
	/** Pause before each action ("reading / aiming" time). */
	beforeAction: number;
	/** Pause after a click. */
	afterClick: number;
	/** Pause after typing finished. */
	afterType: number;
	/** Mean per-character typing delay. */
	typeDelay: number;
	/** Time the cursor rests on a target before clicking. */
	aimDwell: number;
}

export const DEFAULT_PACING: PacingOptions = {
	speed: 1,
	beforeAction: 250,
	afterClick: 550,
	afterType: 700,
	typeDelay: 70,
	aimDwell: 140,
};

export interface ActionOptions {
	/** Zoom onto the target (click/type default true, hover default false). */
	zoom?: boolean | ZoomHint;
	label?: string;
	/** Wait for a navigation started by this click. */
	navigates?: boolean;
}

type CursorKind = NonNullable<CursorSample["cursorType"]>;

export class Scene {
	readonly samples: CursorSample[] = [];
	readonly actions: ActionRecord[] = [];
	readonly captions: Caption[] = [];
	private cursor: Point;
	private cursorKind: CursorKind = "arrow";
	private cursorBox: Box | null = null;
	private rand: () => number;
	private recorder: ScreencastRecorder | null = null;
	private startRecording: () => Promise<ScreencastRecorder>;
	pacing: PacingOptions;

	constructor(
		readonly page: Page,
		readonly viewport: Viewport,
		startRecording: () => Promise<ScreencastRecorder>,
		opts: { seed?: number; pacing?: Partial<PacingOptions> } = {},
	) {
		this.startRecording = startRecording;
		this.rand = mulberry32(opts.seed ?? 42);
		this.pacing = { ...DEFAULT_PACING, ...opts.pacing };
		this.cursor = { x: viewport.width * 0.62, y: viewport.height * 0.72 };
	}

	// ---- clock / telemetry -------------------------------------------------------------------

	private async ensureRecording() {
		if (!this.recorder) {
			this.recorder = await this.startRecording();
			this.sample("move");
		}
	}

	private now() {
		return this.recorder ? this.recorder.now() : 0;
	}

	private sample(interactionType: CursorSample["interactionType"] = "move") {
		if (!this.recorder) return;
		this.samples.push({
			timeMs: Math.max(0, this.now()),
			cx: this.cursor.x / this.viewport.width,
			cy: this.cursor.y / this.viewport.height,
			cursorType: this.cursorKind,
			interactionType,
			visible: true,
		});
	}

	private ms(v: number) {
		return v / this.pacing.speed;
	}

	// ---- helpers ------------------------------------------------------------------------------

	private locate(target: Target): Locator {
		// Prefer the first *visible* match (docs sites often duplicate nav for mobile drawers).
		const loc = typeof target === "string" ? this.page.locator(target) : target;
		return loc.filter({ visible: true }).first();
	}

	private async inspect(loc: Locator): Promise<{ box: Box; kind: CursorKind }> {
		try {
			await loc.waitFor({ state: "visible", timeout: 10_000 });
		} catch (e) {
			throw new Error(`target not visible on ${this.page.url()}: ${loc} (${(e as Error).message.split("\n")[0]})`);
		}
		const info = await loc.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const cursor = getComputedStyle(el).cursor;
			const tag = el.tagName.toLowerCase();
			const editable =
				tag === "textarea" || (tag === "input" && !/^(button|submit|checkbox|radio|range)$/i.test((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable;
			const clickable = tag === "a" || tag === "button" || el.getAttribute("role") === "button" || tag === "summary" || tag === "select" || tag === "label";
			return {
				box: { x: r.x, y: r.y, width: r.width, height: r.height },
				kind: cursor === "pointer" || (cursor === "auto" && clickable) ? "pointer" : cursor === "text" || (cursor === "auto" && editable) ? "text" : "arrow",
			};
		});
		return info as { box: Box; kind: CursorKind };
	}

	private inViewport(box: Box) {
		return box.y >= 0 && box.y + box.height <= this.viewport.height && box.x >= 0 && box.x + box.width <= this.viewport.width;
	}

	/** Scrolls the target into view (animated, recorded) if needed and returns its box. */
	private async prepare(target: Target) {
		const loc = this.locate(target);
		let info = await this.inspect(loc);
		if (!this.inViewport(info.box)) {
			await this.scrollTo(loc);
			info = await this.inspect(loc);
		}
		return { loc, ...info };
	}

	private aimPoint(box: Box): Point {
		// Aim near the centre, slightly randomised, never at the exact edge.
		const jx = (this.rand() - 0.5) * Math.min(box.width * 0.3, 24);
		const jy = (this.rand() - 0.5) * Math.min(box.height * 0.3, 8);
		return { x: box.x + box.width / 2 + jx, y: box.y + box.height / 2 + jy };
	}

	private kindAt(p: Point, target: Box | null, targetKind: CursorKind): CursorKind {
		const inside = (b: Box | null) => b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
		if (inside(target)) return targetKind;
		if (inside(this.cursorBox)) return this.cursorKind;
		return "arrow";
	}

	/** Moves the real mouse along an eased curve at ~60 Hz, recording every position. */
	async moveTo(to: Point, target: Box | null = null, targetKind: CursorKind = "arrow") {
		await this.ensureRecording();
		const from = { ...this.cursor };
		const dist = Math.hypot(to.x - from.x, to.y - from.y);
		const duration = travelDuration(dist, target ? Math.min(target.width, target.height) : 40, this.pacing.speed);
		if (duration > 0) {
			const path = makePath(from, to, this.rand);
			const t0 = performance.now();
			for (;;) {
				const t = Math.min(1, (performance.now() - t0) / duration);
				const p = path(easeAimed(t));
				this.cursor = p;
				await this.page.mouse.move(p.x, p.y);
				this.cursorKind = this.kindAt(p, target, targetKind);
				this.sample("move");
				if (t >= 1) break;
				await sleep(16 - ((performance.now() - t0) % 16));
			}
		}
		this.cursor = to;
		this.cursorKind = this.kindAt(to, target, targetKind);
		if (target) {
			this.cursorBox = target;
			this.cursorKind = targetKind;
		}
		await this.page.mouse.move(to.x, to.y);
		this.sample("move");
	}

	private async clickHere() {
		await this.page.mouse.down();
		this.sample("click");
		await sleep(this.ms(70 + this.rand() * 40));
		await this.page.mouse.up();
		this.sample("mouseup");
	}

	private record(a: Omit<ActionRecord, "endMs">) {
		const rec: ActionRecord = { ...a, endMs: this.now() };
		this.actions.push(rec);
		return rec;
	}

	// ---- public API ---------------------------------------------------------------------------

	async goto(url: string, opts: { waitUntil?: "load" | "domcontentloaded" | "networkidle" } = {}) {
		const startMs = this.now();
		await this.page.goto(url, { waitUntil: opts.waitUntil ?? "load" });
		this.cursorBox = null;
		if (!this.recorder) {
			await this.ensureRecording();
			await this.page.mouse.move(this.cursor.x, this.cursor.y);
			await this.pause(600);
			return;
		}
		this.record({ kind: "goto", startMs, arriveMs: startMs, label: url });
		await this.pause(500);
	}

	async click(target: Target, opts: ActionOptions = {}) {
		await this.ensureRecording();
		await sleep(this.ms(this.pacing.beforeAction));
		const { box, kind } = await this.prepare(target);
		const startMs = this.now();
		const urlBefore = this.page.url();
		await this.moveTo(this.aimPoint(box), box, kind);
		const arriveMs = this.now();
		await sleep(this.ms(this.pacing.aimDwell));
		const nav = opts.navigates ? this.page.waitForURL((u) => u.toString() !== urlBefore, { timeout: 15000 }) : null;
		await this.clickHere();
		if (nav) await nav;
		this.record({ kind: "click", startMs, arriveMs, box, zoom: opts.zoom ?? true, label: opts.label });
		await sleep(this.ms(this.pacing.afterClick));
		if (opts.navigates || this.page.url() !== urlBefore) {
			await this.page.waitForLoadState("load");
			this.cursorBox = null;
		}
	}

	async type(target: Target, text: string, opts: ActionOptions & { clear?: boolean } = {}) {
		await this.ensureRecording();
		await sleep(this.ms(this.pacing.beforeAction));
		const { loc, box, kind } = await this.prepare(target);
		const startMs = this.now();
		await this.moveTo(this.aimPoint(box), box, kind);
		const arriveMs = this.now();
		await sleep(this.ms(this.pacing.aimDwell));
		await this.clickHere();
		if (opts.clear) await loc.fill("");
		await sleep(this.ms(180));
		for (const ch of text) {
			await this.page.keyboard.type(ch);
			const base = this.pacing.typeDelay * (0.55 + this.rand() * 0.9);
			await sleep(this.ms(ch === " " ? base * 1.6 : base));
		}
		this.record({ kind: "type", startMs, arriveMs, box, zoom: opts.zoom ?? true, label: opts.label, text });
		await sleep(this.ms(this.pacing.afterType));
	}

	async press(key: string) {
		await this.ensureRecording();
		const startMs = this.now();
		await this.page.keyboard.press(key);
		this.record({ kind: "press", startMs, arriveMs: startMs, label: key });
		await sleep(this.ms(300));
	}

	async hover(target: Target, opts: ActionOptions & { dwell?: number } = {}) {
		await this.ensureRecording();
		await sleep(this.ms(this.pacing.beforeAction));
		const { box, kind } = await this.prepare(target);
		const startMs = this.now();
		await this.moveTo(this.aimPoint(box), box, kind);
		const arriveMs = this.now();
		await sleep(this.ms(opts.dwell ?? 900));
		this.record({ kind: "hover", startMs, arriveMs, box, zoom: opts.zoom ?? false, label: opts.label });
	}

	/**
	 * Smoothly scrolls the page (or the target's scroll container) so the target is centred,
	 * or by a pixel delta: `scroll({ by: 600 })`.
	 */
	async scroll(target: Target | { by: number }, opts: { duration?: number } = {}) {
		await this.ensureRecording();
		await sleep(this.ms(this.pacing.beforeAction));
		if (typeof target === "object" && "by" in target) {
			await this.animateScroll(null, target.by, opts.duration);
		} else {
			await this.scrollTo(this.locate(target), opts.duration);
		}
		await sleep(this.ms(350));
	}

	private async scrollTo(loc: Locator, duration?: number) {
		const delta = await loc.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return r.top + r.height / 2 - window.innerHeight * 0.45;
		});
		await this.animateScroll(loc, delta, duration);
	}

	private async animateScroll(loc: Locator | null, delta: number, duration?: number) {
		const startMs = this.now();
		const dur = this.ms(duration ?? Math.min(1600, Math.max(500, 380 + Math.abs(delta) * 0.6)));
		const fn = async (el: Element | null, args: { delta: number; dur: number }) => {
			const isScrollable = (n: Element) => {
				const s = getComputedStyle(n);
				return /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1;
			};
			let box: Element | null = el?.parentElement ?? null;
			while (box && box !== document.body && !isScrollable(box)) box = box.parentElement;
			const scroller = box && box !== document.body ? box : (document.scrollingElement ?? document.documentElement);
			const html = document.documentElement;
			const prevBehavior = html.style.scrollBehavior;
			html.style.scrollBehavior = "auto";
			(scroller as HTMLElement).style.scrollBehavior = "auto";
			const from = scroller.scrollTop;
			const max = scroller.scrollHeight - scroller.clientHeight;
			const to = Math.max(0, Math.min(max, from + args.delta));
			const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
			await new Promise<void>((resolve) => {
				const t0 = performance.now();
				const step = () => {
					const t = Math.min(1, (performance.now() - t0) / args.dur);
					scroller.scrollTop = from + (to - from) * ease(t);
					if (t < 1) requestAnimationFrame(step);
					else resolve();
				};
				requestAnimationFrame(step);
			});
			html.style.scrollBehavior = prevBehavior;
		};
		// <html> has no scrollable parent, so it resolves to the document scroller.
		await (loc ?? this.page.locator("html")).evaluate(fn, { delta, dur });
		this.cursorBox = null;
		this.record({ kind: "scroll", startMs, arriveMs: startMs });
	}

	async pause(ms: number) {
		await this.ensureRecording();
		const startMs = this.now();
		await sleep(this.ms(ms));
		this.sample("move");
		this.record({ kind: "pause", startMs, arriveMs: startMs });
	}

	/**
	 * Shows a caption (rendered by OpenScreen as a text annotation, so it stays sharp and
	 * unaffected by zoom). Non-blocking unless `wait` is set.
	 */
	async caption(text: string, opts: { duration?: number; wait?: boolean } = {}) {
		await this.ensureRecording();
		const duration = this.ms(opts.duration ?? 2600);
		const startMs = this.now();
		this.captions.push({ text, startMs, endMs: startMs + duration });
		if (opts.wait) await sleep(duration);
	}
}
