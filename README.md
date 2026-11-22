# demoreel (prototype)

Scripted product demo videos ("videos as code"): write a scenario, record it in headless
Chromium, get auto cursor + auto zoom, rendered to MP4 by OpenScreen's own exporter.

```bash
bun install
bun src/cli.ts run examples/local-demo.ts --out out/local --gpu   # record + project + render + sheet
bun src/cli.ts run examples/schemez.ts --out out/schemez --gpu
bun src/cli.ts render out/local/local-demo.openscreen --gpu      # re-render (e.g. after editing in OpenScreen)
bun src/cli.ts validate out/local/local-demo.openscreen          # OpenScreen validateProjectData/normalizeProjectEditor
bun src/cli.ts sheet out/local/local-demo.mp4 --n 12             # contact sheet
```

Pipeline: `Scene` (Playwright, eased mouse paths, telemetry) -> CDP screencast frames ->
CFR H.264 `recording.mp4` + `recording.mp4.cursor.json` -> zoom regions from target boxes ->
`<name>.openscreen` (v2 project) -> headless Chromium page that runs OpenScreen's
`VideoExporter` (WebCodecs + Pixi) -> `<name>.mp4`.

`vendor/openscreen/` holds unmodified MIT-licensed files from
https://github.com/siddharthvaddem/openscreen (see `vendor/openscreen/LICENSE` and
`VENDORED.md`); regenerate with `bun scripts/vendor-openscreen.ts <checkout>`.
