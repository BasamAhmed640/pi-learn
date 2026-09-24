import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPiLoader, importPiSdk, repoRoot } from "../helpers/pi.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");

test("linked Obsidian lessons get a proactive but selective image policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-image-policy-"));
	mkdirSync(join(root, ".obsidian"));
	const note = join(root, "Packaging.md");
	writeFileSync(note, "# Packaging\n");
	const { loadExtensions, createExtensionRuntime } = await importPiLoader();
	const loaded = await loadExtensions([join(repoRoot, "extensions", "commons-images.ts")], root, undefined, createExtensionRuntime());
	assert.deepEqual(loaded.errors, []);
	const handlers = loaded.extensions[0].handlers.get("before_agent_start") ?? [];
	assert.ok(handlers.length > 0);
	const run = async (entries) => {
		const event = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
		for (const handler of handlers) await handler(event, { sessionManager: { getEntries: () => entries } });
		return event.systemPromptOptions.sections.reference_images;
	};
	assert.equal(await run([]), undefined, "ordinary Pi work is not given a lesson image rule");
	const link = { type: "custom", customType: "md-log", data: { file: note } };
	const policy = await run([link]);
	for (const phrase of ["first relevant explanation", "search_commons_images", "broader physical-object term", "import_commons_image", "attribution", "Mermaid"]) {
		assert.ok(policy.includes(phrase), `missing image instruction: ${phrase}`);
	}
	assert.equal(await run([link, { type: "custom", customType: "md-log", data: { file: null } }]), undefined, "unlinked sessions receive no image rule");
});

test("pi loads both Commons tools; search previews before import and returns a vault embed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-commons-loader-"));
	mkdirSync(join(root, ".obsidian"));
	const cwd = join(root, "Learn");
	mkdirSync(cwd);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (url.hostname === "commons.wikimedia.org") {
			const info = {
				mime: "image/png", sha1: "a".repeat(40), size: PNG.length,
				url: "https://upload.wikimedia.org/wikipedia/commons/test.png",
				thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/test.png",
				extmetadata: {
					Artist: { value: "A photographer" }, LicenseShortName: { value: "CC BY 4.0" },
					LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
				},
			};
			return new Response(JSON.stringify({ query: { pages: [{ pageid: 42, title: "File:Lesson.png", index: 1, imageinfo: [info] }] } }),
				{ headers: { "content-type": "application/json" } });
		}
		if (url.hostname === "thumb.wikimedia.org") return new Response(PNG, { headers: { "content-type": "image/png" } });
		throw new Error(`unexpected URL: ${url}`);
	};
	let session;
	try {
		const sdk = await importPiSdk();
		const agentDir = sdk.getAgentDir();
		const loader = new sdk.DefaultResourceLoader({
			cwd, agentDir, noExtensions: true,
			additionalExtensionPaths: [join(repoRoot, "extensions", "commons-images.ts")],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) }));
		const runner = session.extensionRunner;
		const search = runner.getToolDefinition("search_commons_images");
		const importer = runner.getToolDefinition("import_commons_image");
		assert.ok(search && importer);
		const ctx = () => runner.createContext();
		const rejected = await importer.execute("bad", { candidate_id: "42" }, undefined, () => {}, ctx());
		assert.equal(rejected.details.ok, false);
		const found = await search.execute("search", { query: "lesson image" }, undefined, () => {}, ctx());
		assert.equal(found.details.count, 1);
		assert.equal(found.content.filter((c) => c.type === "image").length, 1);
		const imported = await importer.execute("import", { candidate_id: "42" }, undefined, () => {}, ctx());
		assert.equal(imported.details.ok, true);
		assert.match(imported.details.embed, /!\[\[pi-learn-images\/commons-42-/);
		assert.match(imported.content[0].text, /CC BY 4\.0/);
		assert.ok(existsSync(imported.details.path));
	} finally {
		session?.dispose();
		globalThis.fetch = originalFetch;
	}
});
