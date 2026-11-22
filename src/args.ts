/** CLI argument parsing (no dependencies; Node 20 compatible). */

export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
	type: FlagType;
	alias?: string;
	description: string;
	/** Shown in help, e.g. "DIR". */
	value?: string;
}

export interface CommandSpec {
	usage: string;
	description: string;
	/** Required positional count. */
	positionals: { min: number; max: number };
	flags: Record<string, FlagSpec>;
}

const gpu: FlagSpec = { type: "boolean", description: "force GPU on/off (default: auto-detect, fall back to software)" };
const fps: FlagSpec = { type: "number", value: "N", description: "output frame rate (default 30)" };
const quality: FlagSpec = { type: "string", value: "Q", description: "medium (720p) | good (1080p, default) | source" };
const verbose: FlagSpec = { type: "boolean", alias: "v", description: "print browser console output" };
const frames: FlagSpec = { type: "number", alias: "n", value: "N", description: "contact sheet tiles (default 12)" };
const framesheet: FlagSpec = { type: "string", value: "MODE", description: "auto (default: use framesheet if found) | off" };
const trimIdle: FlagSpec = { type: "boolean", description: "cut idle stretches (OpenScreen trim regions)" };

export const COMMANDS: Record<string, CommandSpec> = {
	run: {
		usage: "run <scenario.ts|js>",
		description: "record a scenario, write the OpenScreen project, render the MP4 and a contact sheet",
		positionals: { min: 1, max: 1 },
		flags: {
			out: { type: "string", alias: "o", value: "DIR", description: "output directory (default out/<name>)" },
			render: { type: "boolean", description: "render the MP4 (default; --no-render to only record)" },
			sheet: { type: "boolean", description: "write a contact sheet after rendering (default)" },
			gpu,
			fps,
			quality,
			"trim-idle": trimIdle,
			speed: { type: "number", value: "X", description: "pacing speed multiplier (2 = twice as fast)" },
			viewport: { type: "string", value: "WxH", description: "override the scenario viewport, e.g. 1280x720" },
			headed: { type: "boolean", description: "show the browser while recording" },
			frames,
			framesheet,
			verbose,
		},
	},
	render: {
		usage: "render <project.openscreen>",
		description: "render an OpenScreen project to MP4 with OpenScreen's exporter (headless)",
		positionals: { min: 1, max: 1 },
		flags: {
			out: { type: "string", alias: "o", value: "FILE", description: "output MP4 (default: next to the project)" },
			gpu,
			fps,
			quality,
			verbose,
		},
	},
	rezoom: {
		usage: "rezoom <outdir>",
		description: "re-derive zoom / idle regions, project and marks from timeline.json (no re-recording)",
		positionals: { min: 1, max: 1 },
		flags: {
			options: { type: "string", value: "JSON", description: 'zoom options, e.g. \'{"maxDepth":4,"holdMs":1200}\'' },
			"max-depth": { type: "number", value: "D", description: "deepest automatic zoom (1-6)" },
			lead: { type: "number", value: "MS", description: "zoom-in lead before the cursor arrives" },
			hold: { type: "number", value: "MS", description: "stay zoomed after an action" },
			"auto-zoom": { type: "boolean", description: "automatic zooms (--no-auto-zoom: only scene.zoom())" },
			"trim-idle": trimIdle,
			"idle-options": { type: "string", value: "JSON", description: 'e.g. \'{"minMs":1500,"keepMs":800,"mode":"speed"}\'' },
			render: { type: "boolean", description: "render the MP4 afterwards" },
			gpu,
			fps,
			quality,
			verbose,
		},
	},
	validate: {
		usage: "validate <project.openscreen>",
		description: "run OpenScreen's validateProjectData / normalizeProjectEditor on a project",
		positionals: { min: 1, max: 1 },
		flags: { json: { type: "boolean", description: "print the full result as JSON" } },
	},
	sheet: {
		usage: "sheet <video.mp4|outdir>",
		description: "contact sheet via framesheet (with marks.json) or ffmpeg",
		positionals: { min: 1, max: 1 },
		flags: {
			out: { type: "string", alias: "o", value: "DIR", description: "output directory (default: next to the video)" },
			marks: { type: "string", value: "FILE", description: "framesheet marks (default: marks.json next to the video)" },
			frames,
			framesheet,
		},
	},
	init: {
		usage: "init [dir]",
		description: "scaffold an example scenario (and a copy of the demo app)",
		positionals: { min: 0, max: 1 },
		flags: {
			name: { type: "string", value: "NAME", description: 'scenario name (default "demo")' },
			url: { type: "string", value: "URL", description: "record this URL instead of the bundled demo app" },
			js: { type: "boolean", description: "write a .mjs scenario instead of .ts" },
			force: { type: "boolean", description: "overwrite existing files" },
		},
	},
	doctor: {
		usage: "doctor",
		description: "check Chromium, ffmpeg, GPU and framesheet",
		positionals: { min: 0, max: 0 },
		flags: {},
	},
};

export type FlagValue = string | number | boolean;

export interface ParsedArgs {
	command: string | null;
	positionals: string[];
	flags: Record<string, FlagValue>;
	help: boolean;
	version: boolean;
}

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export function parseArgs(argv: string[]): ParsedArgs {
	const res: ParsedArgs = { command: null, positionals: [], flags: {}, help: false, version: false };
	let i = 0;
	while (i < argv.length && argv[i].startsWith("-")) {
		const a = argv[i++];
		if (a === "--help" || a === "-h") res.help = true;
		else if (a === "--version" || a === "-V") res.version = true;
		else throw new UsageError(`unknown option ${a}`);
	}
	if (i >= argv.length) return res;
	const command = argv[i++];
	const spec = COMMANDS[command];
	if (!spec) throw new UsageError(`unknown command "${command}" (try --help)`);
	res.command = command;
	const aliases = new Map(Object.entries(spec.flags).flatMap(([k, f]) => (f.alias ? [[f.alias, k] as const] : [])));
	let onlyPositionals = false;
	for (; i < argv.length; i++) {
		const a = argv[i];
		if (onlyPositionals || !a.startsWith("-") || a === "-") {
			res.positionals.push(a);
			continue;
		}
		if (a === "--") {
			onlyPositionals = true;
			continue;
		}
		if (a === "--help" || a === "-h") {
			res.help = true;
			continue;
		}
		let name: string;
		let inline: string | undefined;
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			name = eq > 0 ? a.slice(2, eq) : a.slice(2);
			inline = eq > 0 ? a.slice(eq + 1) : undefined;
		} else {
			const alias = aliases.get(a.slice(1));
			if (!alias) throw new UsageError(`unknown option ${a} for "${command}"`);
			name = alias;
		}
		let negated = false;
		if (!spec.flags[name] && name.startsWith("no-") && spec.flags[name.slice(3)]?.type === "boolean") {
			name = name.slice(3);
			negated = true;
		}
		const f = spec.flags[name];
		if (!f) throw new UsageError(`unknown option --${name} for "${command}"`);
		if (f.type === "boolean") {
			if (inline !== undefined) {
				if (!/^(true|false|1|0)$/.test(inline)) throw new UsageError(`--${name} expects true/false`);
				res.flags[name] = /^(true|1)$/.test(inline) !== negated;
			} else res.flags[name] = !negated;
			continue;
		}
		if (negated) throw new UsageError(`--no-${name} is not valid`);
		const raw = inline ?? argv[++i];
		if (raw === undefined) throw new UsageError(`--${name} needs a value`);
		if (f.type === "number") {
			const n = Number(raw);
			if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
			res.flags[name] = n;
		} else res.flags[name] = raw;
	}
	if (!res.help) {
		const { min, max } = spec.positionals;
		if (res.positionals.length < min) throw new UsageError(`usage: demoreel ${spec.usage}`);
		if (res.positionals.length > max) throw new UsageError(`too many arguments; usage: demoreel ${spec.usage}`);
	}
	return res;
}

/** "1280x720" -> { width, height }. */
export function parseSize(s: string): { width: number; height: number } {
	const m = /^(\d+)\s*[x:*]\s*(\d+)$/i.exec(s.trim());
	if (!m) throw new UsageError(`expected WxH like 1280x720, got "${s}"`);
	return { width: Number(m[1]), height: Number(m[2]) };
}

/** Tri-state GPU flag: true / false / "auto" when absent. */
export function gpuMode(flags: Record<string, FlagValue>): boolean | "auto" {
	return flags.gpu === undefined ? "auto" : Boolean(flags.gpu);
}

export function parseJsonFlag(name: string, raw: FlagValue | undefined): Record<string, unknown> {
	if (raw === undefined) return {};
	try {
		const v = JSON.parse(String(raw));
		if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
		return v;
	} catch (e) {
		throw new UsageError(`--${name} expects a JSON object: ${(e as Error).message}`);
	}
}

export function helpText(command?: string | null): string {
	const fmtFlags = (flags: Record<string, FlagSpec>) =>
		Object.entries(flags)
			.map(([k, f]) => {
				const left = `${f.alias ? `-${f.alias}, ` : "    "}--${f.type === "boolean" ? `[no-]${k}` : k}${f.value ? ` ${f.value}` : ""}`;
				return `  ${left.padEnd(30)} ${f.description}`;
			})
			.join("\n");
	if (command && COMMANDS[command]) {
		const c = COMMANDS[command];
		return `demoreel ${c.usage}\n\n${c.description}\n${Object.keys(c.flags).length ? `\noptions:\n${fmtFlags(c.flags)}\n` : ""}`;
	}
	const list = Object.values(COMMANDS)
		.map((c) => `  ${c.usage.padEnd(32)} ${c.description}`)
		.join("\n");
	return `demoreel: scripted product demo videos (auto cursor + auto zoom, rendered by OpenScreen)\n\nusage: demoreel <command> [options]\n\ncommands:\n${list}\n\nrun \`demoreel <command> --help\` for options.\n`;
}
