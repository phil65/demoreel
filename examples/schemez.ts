import { defineScenario } from "@phil65/demoreel";

/** Public docs site: open the API reference, go to a class page, scroll, hover members. */
export default defineScenario({
	name: "schemez-docs",
	viewport: { width: 1920, height: 1080 },
	async run(scene) {
		await scene.goto("https://phil65.github.io/schemez/");
		await scene.caption("schemez: Pydantic toolkit for schemas and code", { duration: 3000 });
		await scene.hover("article h1", { dwell: 700 });
		await scene.click('.md-tabs a:text-is("API")', { label: "API tab", navigates: true });
		await scene.caption("Browse the API reference", { duration: 2600 });
		await scene.click('nav.md-nav--primary a[href="./schema/"]', { label: "schema module", navigates: true });
		await scene.click('nav.md-nav--primary a[href="./Schema/"]', { label: "Schema class", navigates: true });
		await scene.pause(700);
		await scene.hover('article a:text-is("ConfigSchema")', { zoom: true, dwell: 1100 });
		await scene.caption("Jump to a method", { duration: 2400 });
		await scene.scroll('[id="schemez.schema.Schema.from_json_schema"]');
		await scene.hover('[id="schemez.schema.Schema.from_json_schema"]', { zoom: true, dwell: 1400 });
		await scene.scroll({ by: 420 });
		await scene.hover('[id="schemez.schema.Schema.from_json_schema"] ~ .doc-contents .md-typeset__scrollwrap', { zoom: { context: 1 }, dwell: 1400 });
		await scene.pause(600);
	},
});
