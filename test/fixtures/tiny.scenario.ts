import { defineScenario } from "../../src/index.ts";

/** Very short scenario for the integration test (640x360, ~3 s). */
export default defineScenario({
	name: "tiny",
	serve: "../../examples/demo-app",
	viewport: { width: 640, height: 360 },
	pacing: { speed: 2 },
	async run(scene, { baseUrl }) {
		await scene.goto(`${baseUrl}/`);
		await scene.caption("Tiny demo", { duration: 1200 });
		await scene.type("#title", "Hi");
		await scene.click("#add", { label: "add task", zoom: { depth: 3 } });
		await scene.highlight("#list li:first-child", { duration: 600 });
	},
});
