#!/usr/bin/env bash
# Packs demoreel, installs the tarball into a fresh temp project and runs the CLI from there:
#   1. `demoreel init` + `demoreel run demo.scenario.ts --no-render` (TypeScript scenario)
#   2. a ~2 s 640x360 .mjs scenario, recorded and rendered (software GL is fine)
# Usage: scripts/smoke-tarball.sh [--no-render]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/demoreel-smoke-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
TARBALL="$(npm pack --silent --pack-destination "$WORK" | tail -1)"
echo "packed $TARBALL ($(du -h "$WORK/$TARBALL" | cut -f1))"
PW_VERSION="$(node -p "require('./node_modules/playwright/package.json').version")"
cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund "./$TARBALL" "playwright@$PW_VERSION" >/dev/null
npx demoreel --version
npx demoreel doctor || true
npx demoreel init
npx demoreel run demo.scenario.mts --no-render --out out/demo
test -s out/demo/demo.openscreen && test -s out/demo/timeline.json && test -s out/demo/marks.json
npx demoreel validate out/demo/demo.openscreen
if [[ "${1:-}" != "--no-render" ]]; then
  cat > short.scenario.mjs <<'JS'
import { defineScenario } from "@phil65/demoreel";
export default defineScenario({
  name: "short",
  serve: "./demo-app",
  viewport: { width: 640, height: 360 },
  pacing: { speed: 2 },
  async run(scene, { baseUrl }) {
    await scene.goto(`${baseUrl}/`);
    await scene.click("#add", { label: "add task" });
  },
});
JS
  npx demoreel run short.scenario.mjs --out out/short --quality source --fps 30 --framesheet off
  test -s out/short/short.mp4
  ffprobe -v error -show_entries stream=width,height -of csv=p=0 out/short/short.mp4
fi
echo "smoke test passed"
