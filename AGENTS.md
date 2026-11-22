# AGENTS.md: demoreel

## Architecture

```
scenario.ts --loadScenario--> Scenario.run(scene)
  Scene (src/scene.ts)          Playwright actions + eased cursor paths, records
                                ActionRecord[] (boxes, times), CursorSample[], captions
  ScreencastRecorder            CDP Page.startScreencast frames (compositor timestamps)
    (src/recorder.ts)           -> ffmpeg -> CFR H.264 recording.mp4 (sample-and-hold)
  compose (src/compose.ts)      timeline -> zoom regions (zoom.ts), idle trims (idle.ts),
                                caption placement + framesheet marks (marks.ts, layout.ts),
                                OpenScreen project + cursor sidecar (project.ts), timeline.json
  renderProject (src/render.ts) static server (server.ts) for dist/renderer + media/upload
                                endpoints -> headless Chromium -> renderer/main.ts ->
                                OpenScreen VideoExporter -> POST mp4 back
  validateProject               OpenScreen projectPersistence in Node (dist/openscreen/project.js)
  reviewSheet (src/sheet.ts)    framesheet inspect --marks, else ffmpeg tile sheet
```

- `src/` is TypeScript with explicit `.ts` import extensions and erasable syntax only (no
  enums, namespaces or parameter properties): Bun, Node >= 22.18 and vitest run it directly;
  `tsc -p tsconfig.build.json` rewrites the extensions to `.js` for `dist/`.
- `src/openscreen.ts` resolves `dist/renderer` and `dist/openscreen/project.js` relative to the
  package root, so the same code works from `src/` and `dist/`. Run `npm run build:renderer`
  once after cloning (tests need it).
- `layout.ts` mirrors OpenScreen's compositing math (padding scale `1 - p/100*0.4`, centred
  fit, stage-normalised zoom focus, `clampFocusToScale`, `computeZoomTransform`). Zoom focus in
  the project and all marks coordinates are stage / output-frame coordinates.
- Times: everything in `timeline.json` is ms on the recording clock (first screencast frame =
  0). `marks.json` is in seconds of the rendered output (after trims).

## Commands

```bash
npm ci && npx playwright install chromium
npm run build             # dist/renderer (Vite), dist/openscreen, dist/*.js + .d.ts, licenses/
npm run typecheck
npm test                  # unit tests (vitest)
npm run test:integration  # records + renders a 640x360 clip (DEMOREEL_RENDER=0 skips render)
scripts/smoke-tarball.sh  # npm pack, install into a temp project, run the CLI from there
node dist/cli.js run examples/local-demo.ts --out out/local
```

Bun: `bun src/cli.ts run ...` works without building the library (the renderer bundle is
still needed).

## Updating the vendored OpenScreen

`vendor/openscreen/` holds unmodified MIT files (closure of the exporter + project
persistence) and is the source of the prebuilt bundle; it is not shipped raw.

1. `git clone https://github.com/siddharthvaddem/openscreen /tmp/openscreen` (checkout the
   wanted commit).
2. `node scripts/vendor-openscreen.ts /tmp/openscreen` (rewrites `vendor/openscreen/`, incl.
   `VENDORED.md` with the commit and the npm packages the files import).
3. Align `devDependencies` (pixi.js, pixi-filters, mediabunny, web-demuxer, motion, gif.js)
   with OpenScreen's `package.json`, `npm install`.
4. `npm run build:renderer` (also regenerates `THIRD_PARTY_NOTICES.md` and `licenses/`).
5. Check `renderer/main.ts` still matches what `VideoEditor.tsx` passes to `VideoExporter`
   (new config fields), and that `src/layout.ts` / `src/zoom.ts` constants still hold:
   `test/zoom.test.ts` compares DEPTH_SCALES and the transition windows with the bundle.
6. `npm test && npm run test:integration`, look at a rendered sheet.

Never edit files under `vendor/openscreen/`; adapt in `renderer/` or `src/` instead.

## Adding a scene action

1. Add the method to `Scene` in `src/scene.ts`. Call `ensureRecording()`, use `prepare(target)`
   for element targets (scrolls into view, returns box, cursor kind and `data-demoreel-zoom`
   anchor), move with `travel()`, and `record({ kind, startMs, arriveMs, endMs?, box, zoom,
   point, label })`.
2. Add the kind to `ActionKind` in `src/types.ts`.
3. Decide how it affects derived output: zoom (`zoom.ts`, `autoRegions` uses `box`/`zoomBox` +
   `zoom`), idle detection (`idle.ts::busyIntervals`), marks (`marks.ts`: targets get a region,
   clicks/types a point).
4. Unit-test the derivation (`test/zoom.test.ts`, `test/idle-marks.test.ts`), document it in the
   README table and `docs/skill.md`.

## Conventions

Conventional commits. Keep the package dependency-free at runtime (only the Playwright peer).
Don't leave browsers or servers running: every launch is closed in `finally`.
