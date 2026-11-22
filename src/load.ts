/**
 * Loads a scenario module (`export default defineScenario({...})`).
 *
 * - `.js` / `.mjs`: plain dynamic import.
 * - `.ts` / `.mts` on Bun or Deno: native.
 * - `.ts` on Node >= 22.18 / 23.6: native type stripping (erasable TypeScript only).
 * - otherwise: `tsx` or `jiti`, if installed next to the scenario or in the cwd.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DemoreelError } from "./env.ts";
import type { Scenario } from "./record.ts";

const isTs = (f: string) => /\.(c|m)?tsx?$/.test(f);

function resolveFrom(spec: string, dirs: string[]): string | null {
	for (const dir of dirs) {
		try {
			return createRequire(path.join(dir, "noop.js")).resolve(spec);
		} catch {
			// next
		}
	}
	return null;
}

function pickScenario(mod: Record<string, unknown>, file: string): Scenario {
	const candidate = (mod.default ?? mod.scenario ?? mod) as Partial<Scenario> & { default?: Scenario };
	const s = (typeof candidate.run === "function" ? candidate : candidate.default) as Scenario | undefined;
	if (!s || typeof s.run !== "function" || !s.name) {
		throw new DemoreelError(
			`${file} does not export a scenario`,
			"export default defineScenario({ name: 'my-demo', async run(scene) { ... } })",
		);
	}
	return s;
}

export async function loadScenario(file: string): Promise<Scenario> {
	const abs = path.resolve(file);
	const url = pathToFileURL(abs).href;
	const versions = process.versions as Record<string, string | undefined>;
	const native = !isTs(abs) || Boolean(versions.bun) || Boolean(versions.deno);
	let firstError: unknown = null;
	try {
		return pickScenario(await import(url), file);
	} catch (e) {
		if (native || e instanceof DemoreelError) throw e;
		firstError = e;
	}
	// Node without (working) type stripping: fall back to tsx / jiti.
	const dirs = [path.dirname(abs), process.cwd()];
	const tsx = resolveFrom("tsx/esm/api", dirs);
	if (tsx) {
		const api = (await import(pathToFileURL(tsx).href)) as {
			tsImport: (spec: string, parent: string) => Promise<Record<string, unknown>>;
		};
		return pickScenario(await api.tsImport(url, import.meta.url), file);
	}
	const jiti = resolveFrom("jiti", dirs);
	if (jiti) {
		const { createJiti } = (await import(pathToFileURL(jiti).href)) as {
			createJiti: (from: string) => { import: (id: string) => Promise<Record<string, unknown>> };
		};
		return pickScenario({ default: await createJiti(url).import(abs) }, file);
	}
	const code = (firstError as NodeJS.ErrnoException)?.code;
	const msg = (firstError as Error)?.message ?? "";
	if (/Cannot use import statement outside a module|require is not defined in ES module/.test(msg)) {
		throw new DemoreelError(
			`cannot load ${file}: Node treats it as CommonJS`,
			`rename it to ${path.basename(abs).replace(/\.ts$/, ".mts")}, or set "type": "module" in your package.json`,
		);
	}
	const reason =
		code === "ERR_UNKNOWN_FILE_EXTENSION"
			? `this Node (${process.version}) cannot import TypeScript`
			: `importing it failed: ${(firstError as Error)?.message?.split("\n")[0]}`;
	throw new DemoreelError(
		`cannot load ${file}: ${reason}`,
		"use Node >= 22.18, Bun (`bunx demoreel run ...`), `npm i -D tsx` (or `node --import tsx`), or write the scenario in .js/.mjs",
	);
}
