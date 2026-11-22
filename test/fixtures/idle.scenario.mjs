/** Has a long idle stretch so `trimIdle` cuts it (used by manual checks). */
export default {
	name: "idle",
	serve: "../../examples/demo-app",
	viewport: { width: 640, height: 360 },
	trimIdle: true,
	async run(scene, { baseUrl }) {
		await scene.goto(`${baseUrl}/`);
		await scene.click("#add", { label: "add task", zoom: false });
		await scene.pause(3000);
		await scene.click('[data-filter="open"]', { zoom: false });
	},
};
