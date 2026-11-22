#!/usr/bin/env bun
/**
 * demoreel CLI
 *
 *   demoreel run <scenario.ts> [--out DIR] [--no-render] [--gpu] [--fps 60] [--quality good]
 *   demoreel render <project.openscreen> [--out FILE.mp4] [--gpu]
 *   demoreel rezoom <out-dir> [--options '{"maxDepth":4}']
 *   demoreel validate <project.openscreen>
 *   demoreel sheet <video.mp4> [--out FILE.png] [--n 12]
 */
import path from "node:path";
import { recordScenario, type Scenario } from "./record";
import { renderProject, validateProject } from "./render";
import { contactSheet } from "./sheet";

function parse(argv: string[]) {
	const pos: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--no-")) flags[a.slice(5)] = false;
		else if (a.startsWith("--")) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[a.slice(2)] = next;
				i++;
			} else flags[a.slice(2)] = true;
		} else pos.push(a);
	}
	return { pos, flags };
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, flags } = parse(rest);
const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
	switch (cmd) {
		case "run": {
			const file = path.resolve(pos[0]);
			const scenario: Scenario = (await import(file)).default;
			const out = path.resolve(String(flags.out ?? path.join("out", scenario.name)));
			console.log(`recording "${scenario.name}" -> ${out}`);
			const { result, projectPath, zoomRegions } = await recordScenario(scenario, file, out);
			console.log(
				`  recorded ${fmt(result.durationMs)}, ${result.frameCount} frames @ ${result.frameSize.width}x${result.frameSize.height}, ` +
					`${result.samples.length} cursor samples, ${result.actions.length} actions, ${zoomRegions.length} zoom regions`,
			);
			console.log(`  timings: ${Object.entries(result.timings).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}`);
			const v = await validateProject(projectPath);
			console.log(`  OpenScreen validateProjectData: ${v.valid}; fields changed by normalizeProjectEditor: [${v.changedByNormalize.join(", ")}]`);
			console.log(`  project: ${projectPath}`);
			if (flags.render === false) break;
			const mp4 = path.join(out, `${scenario.name}.mp4`);
			const r = await renderProject({ projectPath, outputPath: mp4, gpu: Boolean(flags.gpu), frameRate: Number(flags.fps ?? 60), quality: flags.quality as never, verbose: Boolean(flags.verbose) });
			console.log(`  rendered ${r.width}x${r.height} ${(r.bytes / 1e6).toFixed(1)} MB in ${fmt(r.renderMs)} (setup ${fmt(r.setupMs)}) -> ${mp4}`);
			if (r.warnings.length) console.log(`  warnings: ${r.warnings.join("; ")}`);
			const sheet = await contactSheet(mp4, path.join(out, `${scenario.name}.sheet.png`), Number(flags.n ?? 12));
			console.log(`  contact sheet: ${sheet.outPng}`);
			break;
		}
		case "render": {
			const projectPath = path.resolve(pos[0]);
			const out = path.resolve(String(flags.out ?? projectPath.replace(/\.openscreen$/, ".mp4")));
			const r = await renderProject({ projectPath, outputPath: out, gpu: Boolean(flags.gpu), frameRate: Number(flags.fps ?? 60), quality: flags.quality as never, verbose: Boolean(flags.verbose) });
			console.log(`rendered ${r.width}x${r.height} in ${fmt(r.renderMs)} -> ${out}`);
			break;
		}
		case "rezoom": {
			// Re-derive zoom regions from timeline.json (no re-recording), e.g. after tuning options.
			const dir = path.resolve(pos[0]);
			const fs = await import("node:fs");
			const { deriveZoomRegions } = await import("./zoom");
			const tl = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8"));
			const projectPath = path.join(dir, `${tl.scenario}.openscreen`);
			const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
			const opts = typeof flags.options === "string" ? JSON.parse(flags.options) : {};
			project.editor.zoomRegions = deriveZoomRegions(tl.actions, tl.viewport, tl.durationMs, opts);
			fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));
			console.log(JSON.stringify(project.editor.zoomRegions, null, 1));
			break;
		}
		case "validate": {
			console.log(JSON.stringify(await validateProject(path.resolve(pos[0])), null, 2));
			break;
		}
		case "sheet": {
			const video = path.resolve(pos[0]);
			const r = await contactSheet(video, path.resolve(String(flags.out ?? video.replace(/\.\w+$/, ".sheet.png"))), Number(flags.n ?? 12));
			console.log(r.outPng);
			break;
		}
		default:
			console.log("usage: demoreel run|render|validate|sheet ... (see src/cli.ts)");
			process.exit(cmd ? 1 : 0);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
