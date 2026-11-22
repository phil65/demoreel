---
name: demoreel
description: Make or improve a product demo video with demoreel (Playwright scenario -> auto cursor + auto zoom -> MP4 via OpenScreen). Use when asked to record a demo, screencast or walkthrough video of a web app, or to fix pacing, zoom or captions of one.
---

# demoreel: the demo video loop

You write a scenario, run it, inspect a contact sheet instead of watching the video, tune,
and repeat. Never judge a video you have not inspected.

## 1. Write the scenario

```ts
import { defineScenario } from "demoreel";

export default defineScenario({
	name: "checkout",
	viewport: { width: 1920, height: 1080 },
	cssZoom: 1.5,            // only for pages whose layout you control; crisper text
	// trimIdle: true,       // cut dead time
	async run(scene) {
		await scene.goto("http://localhost:3000/");
		await scene.caption("Pay in two clicks", { duration: 2800 });
		await scene.click("text=Add to cart", { label: "add to cart" });
		await scene.click("#checkout", { navigates: true });
		await scene.type("#card", "4242 4242 4242 4242");
		await scene.zoom("#total", { depth: 3, duration: 2000, wait: true });
		await scene.highlight(".receipt", { duration: 1800 });
	},
});
```

- Use stable selectors (ids, roles, `text=`), give every important action a `label`: labels show
  up in `timeline.json`, `marks.json` and the sheet.
- One idea per caption, 2.5-3.5 s each; start the caption before the action it explains.
- Navigation clicks need `navigates: true`.
- Name the file `*.scenario.ts` in an ESM package, `*.scenario.mts` otherwise.

## 2. Run

```bash
npx demoreel run checkout.scenario.ts --out out/checkout      # record + render + sheet
npx demoreel run checkout.scenario.ts --no-render             # fast: record only
npx demoreel run checkout.scenario.ts --quality medium --fps 30   # cheaper drafts
```

No GPU (CI, containers): software rendering is slow; draft with `--viewport 1280x720
--quality source --fps 30` and render the final 1080p60 once.

## 3. Inspect

```bash
npx demoreel sheet out/checkout -n 16     # framesheet inspect <mp4> --marks marks.json
```

Read the printed findings, then look at `out/checkout/framesheet/sheet.png` (tiles with click
points, target boxes, zoom spans and captions drawn on, plus a timeline). Also read
`out/checkout/timeline.json` (actions with times and boxes, `zoomRegions`, `trimRegions`).

What to look for:

- **Caption covering the target** (framesheet `video-mark-overlap`): the caption box overlaps a
  target box while it is active. Fix: shift the caption in time, shorten it, or set
  `look.captionPosition` (`"auto"` already avoids active targets where it can).
- **Zoom on the wrong element / too tight / too loose**: the target box is not where the
  action happens, or the zoomed tile cuts off context the viewer needs. Fix: zoom onto a
  container with `data-demoreel-zoom` on it, `{ zoom: { context: 2 } }`, `{ zoom: { depth: 2 } }`,
  `{ zoom: false }`, an explicit `scene.zoom(...)`, or scenario `zoom.maxDepth`.
- **Dead time**: tiles marked duplicate / long static stretches in the timeline, gaps between
  actions after page loads. Fix: `trimIdle: true`, shorter `pause()`, `pacing.speed`.
- **Too fast**: actions closer than ~0.8 s, captions shorter than ~2 s, zoom regions that
  last less than ~1.5 s (they flash). Fix: `pause()`, longer `duration`, `pacing.speed` < 1.
- **Pan/zoom ping-pong**: many short zoom regions alternating far apart. Fix: larger
  `mergeGapMs`, `maxDepth` lower, or one explicit `scene.zoom()` over the whole step.
- **Wrong state**: a tile shows an error page, a spinner or an empty list. Fix the scenario
  (wait for the element: `scene.hover(sel)` waits until it is visible) or the app data.
- **Blank or black tiles** at the start/end: page not loaded at the first `goto`, or the
  ending hold is too short/long.

## 4. Tune without re-recording when you can

Zoom and idle changes do not need a new recording:

```bash
npx demoreel rezoom out/checkout --max-depth 2 --hold 1200 --render
npx demoreel rezoom out/checkout --trim-idle --idle-options '{"minMs":1500,"keepMs":700}' --render
npx demoreel rezoom out/checkout --no-auto-zoom --render      # only explicit scene.zoom()
```

Changes to actions, captions, pacing, selectors or `look` need `demoreel run` again.

## 5. Repeat

Run -> sheet -> fix the worst problem -> run again, until the sheet has no findings you can
fix and every tile shows what its caption says. Report the final MP4 path, its duration and
the sheet, and mention anything you could not fix.
