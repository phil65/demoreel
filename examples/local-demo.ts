import { defineScenario } from "@phil65/demoreel";

export default defineScenario({
	name: "local-demo",
	serve: "./demo-app",
	viewport: { width: 1920, height: 1080 },
	cssZoom: 1.5,
	async run(scene, { baseUrl }) {
		await scene.goto(`${baseUrl}/`);
		await scene.caption("Add a task in seconds", { duration: 3000 });
		await scene.type("#title", "Ship the demo video");
		await scene.type("#owner", "Phil");
		await scene.click("#add", { label: "add task" });
		await scene.pause(600);
		await scene.caption("Filter and complete tasks", { duration: 3500 });
		await scene.click('[data-filter="open"]');
		await scene.click("#list li:nth-child(2) .check", { label: "complete" });
		await scene.click('[data-filter="all"]');
		await scene.pause(800);
	},
});
