/**
 * GUI-level check: open a generated .openscreen project in a real OpenScreen build.
 *
 * Launches an *extracted* OpenScreen AppImage via Playwright's Electron driver under Xvfb, with an
 * isolated config dir (XDG_CONFIG_HOME/HOME in a temp dir, so the owner's ~/.config/openscreen is
 * never touched), stubs the native "Open project" dialog to return our file, opens the editor,
 * loads the project and screenshots the editor. The app is closed afterwards.
 *
 *   xvfb-run -a -s "-screen 0 1920x1200x24" bun scripts/check-openscreen-gui.ts \
 *     <path/to/squashfs-root/openscreen> <project.openscreen> <out-dir>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const [exe, projectArg, outArg] = process.argv.slice(2);
const projectPath = path.resolve(projectArg);
const outDir = path.resolve(outArg ?? ".");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-check-"));

const app = await electron.launch({
	executablePath: path.resolve(exe),
	args: ["--no-sandbox"],
	env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
	timeout: 60_000,
});
const logs: string[] = [];
try {
	await app.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
	}, projectPath);
	const first = await app.firstWindow();
	await first.waitForLoadState("domcontentloaded");
	await first.waitForTimeout(1500);
	// switchToEditor closes the HUD window, so the evaluate may reject with "target closed".
	await first.evaluate(() => (window as any).electronAPI.switchToEditor()).catch(() => {});
	let editor = app.windows().find((w) => w.url().includes("windowType=editor"));
	for (let i = 0; !editor && i < 40; i++) {
		await new Promise((r) => setTimeout(r, 250));
		editor = app.windows().find((w) => w.url().includes("windowType=editor"));
	}
	if (!editor) throw new Error("editor window did not open");
	editor.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
	await editor.waitForLoadState("domcontentloaded");
	await editor.waitForTimeout(2000);
	await editor.screenshot({ path: path.join(outDir, "openscreen-gui-empty.png") });
	// Empty state has a "Load project" button; fall back to the keyboard shortcut.
	const btn = editor.getByRole("button", { name: /load project|open project/i }).first();
	if (await btn.count()) await btn.click();
	else await editor.keyboard.press("Control+O");
	await editor.waitForTimeout(5000);
	await editor.screenshot({ path: path.join(outDir, "openscreen-gui-loaded.png") });
	const toast = await editor.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
	const body = (await editor.locator("body").innerText()).slice(0, 1500);
	fs.writeFileSync(path.join(outDir, "openscreen-gui-check.json"), JSON.stringify({ toast, body, logs: logs.slice(-60) }, null, 2));
	console.log(JSON.stringify({ toast, logsTail: logs.filter((l) => /error|warn|project/i.test(l)).slice(-15) }, null, 2));
} finally {
	await app.close().catch(() => {});
	fs.rmSync(home, { recursive: true, force: true });
}
