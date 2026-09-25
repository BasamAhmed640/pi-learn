import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	for (const phrase of ["Phase 2", "dependency-map nodes", "Phase 3", "exact visible feature", "image quota", "first relevant explanation", "search_commons_images", "broaden the query only", "Never substitute an LGA underside for a BGA", "import_commons_image", "needed_view", "learning_goal", "what_to_notice", "alt_text", "attribution", "Mermaid"]) {
		assert.ok(policy.includes(phrase), `missing image instruction: ${phrase}`);
	}
	const teachSkill = readFileSync(join(repoRoot, "skills", "teach", "SKILL.md"), "utf8");
	for (const phrase of ["Plan visual learning moments", "needed view", "exact observation", "Do not search or import during planning", "planned visual learning moment", "beside the explanation"]) {
		assert.ok(teachSkill.includes(phrase), `missing image planning instruction: ${phrase}`);
	}
	assert.equal(await run([link, { type: "custom", customType: "md-log", data: { file: null } }]), undefined, "unlinked sessions receive no image rule");
});

test("pi loads both Commons tools; search previews before import and returns a vault embed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-commons-loader-"));
	mkdirSync(join(root, ".obsidian"));
	const cwd = join(root, "Learn");
	mkdirSync(cwd);
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	let reviewerVerdict = "match";
	const reviews = [];
	globalThis.fetch = async (input) => {
		fetches++;
		const url = new URL(String(input));
		if (url.hostname === "commons.wikimedia.org") {
			const query = url.searchParams.get("gsrsearch") ?? "";
			const isLga = query.includes("full-face contacts");
			const isOpaque = query.includes("CPU rear view");
			const info = {
				mime: "image/png", sha1: "a".repeat(40), size: PNG.length,
				url: "https://upload.wikimedia.org/wikipedia/commons/test.png",
				thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/test.png",
				extmetadata: {
					Artist: { value: "A photographer" }, LicenseShortName: { value: "CC BY 4.0" },
					LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
				},
			};
			return new Response(JSON.stringify({ query: { pages: [{ pageid: isLga ? 43 : isOpaque ? 44 : 42, title: isLga ? "File:Intel CPU LGA rear view.png" : isOpaque ? "File:CPU rear view.png" : "File:Lesson.png", index: 1, imageinfo: [info] }] } }),
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
		const ctx = () => ({
			...runner.createContext(),
			model: { id: "fake-vision", provider: "test", input: ["text", "image"] },
			modelRegistry: { streamSimple(model, context, options) {
				reviews.push({ model, context, options });
				return { result: async () => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify({ verdict: reviewerVerdict, observed_subject: "Package underside", reason: reviewerVerdict === "match" ? "Visible grid of solder balls" : "Flat pads are not solder balls" }) }], stopReason: "stop" }) };
			} },
		});
		const rejected = await importer.execute("bad", { candidate_id: "42" }, undefined, () => {}, ctx());
		assert.equal(rejected.details.ok, false);
		const noPurpose = await search.execute("no-purpose", { query: "lesson image", needed_view: "an image", learning_goal: "package connections" }, undefined, () => {}, ctx());
		assert.equal(noPurpose.details.count, 0);
		assert.match(noPurpose.content[0].text, /needed_view/);
		const noGoal = await search.execute("no-goal", { query: "BGA underside", needed_view: "the solder ball grid beneath a BGA package" }, undefined, () => {}, ctx());
		assert.equal(noGoal.details.count, 0);
		assert.match(noGoal.content[0].text, /learning_goal/);
		assert.equal(fetches, 0, "a generic purpose must not trigger a search");
		const found = await search.execute("search", {
			query: "BGA package underside", needed_view: "the solder ball grid beneath a BGA package", learning_goal: "how the package connects to a circuit board",
		}, undefined, () => {}, ctx());
		assert.equal(found.details.count, 1);
		assert.equal(found.content.filter((c) => c.type === "image").length, 1);
		const beforeImport = fetches;
		const noObservation = await importer.execute("no-observation", { candidate_id: "42", what_to_notice: "an image", alt_text: "a BGA package with solder balls" }, undefined, () => {}, ctx());
		assert.equal(noObservation.details.ok, false);
		const noAlt = await importer.execute("no-alt", { candidate_id: "42", what_to_notice: "Notice the regular grid of solder balls on the underside." }, undefined, () => {}, ctx());
		assert.equal(noAlt.details.ok, false);
		assert.match(noAlt.content[0].text, /alt_text/);
		assert.equal(fetches, beforeImport, "an import without an observation must not fetch an image");
		assert.equal(existsSync(join(root, "pi-learn-images")), false, "an import without an observation must not create a vault asset");
		const imported = await importer.execute("import", {
			candidate_id: "42", what_to_notice: "Notice the regular grid of solder balls on the package underside.", alt_text: "Underside of a BGA package showing rows of solder balls",
		}, undefined, () => {}, ctx());
		assert.equal(imported.details.ok, true);
		assert.equal(reviews.length, 1, "a preview receives an independent visual review before import");
		assert.equal(reviews[0].context.messages[0].content[1].type, "image");
		assert.equal(reviews[0].context.messages[0].content[1].mimeType, "image/png");
		assert.equal(reviews[0].options.reasoning, "minimal");
		assert.match(imported.details.embed, /!\[Underside of a BGA package showing rows of solder balls\]\(<\.\.\/pi-learn-images\/commons-42-/);
		assert.match(imported.details.block, /\*Notice: the regular grid of solder balls on the package underside\.\*/);
		assert.doesNotMatch(imported.details.block, /Notice: Notice/i);
		assert.match(imported.content[0].text, /CC BY 4\.0/);
		assert.ok(existsSync(imported.details.path));

		// The original BGA need survives a broadened follow-up search; a named LGA
		// preview is refused before any further network request or vault write.
		await search.execute("bga", { query: "BGA package underside", needed_view: "the BGA solder ball grid on the package underside", learning_goal: "how solder balls connect the package to its circuit board" }, undefined, () => {}, ctx());
		const broadened = await search.execute("broad", { query: "full-face contacts", needed_view: "a full-face grid of contacts", learning_goal: "how package contacts connect to the circuit board" }, undefined, () => {}, ctx());
		assert.equal(broadened.details.count, 1);
		const beforeMismatch = fetches;
		const rejectedLga = await importer.execute("lga", { candidate_id: "43", what_to_notice: "Notice the regular array of flat gold contact pads.", alt_text: "Intel CPU underside with flat gold LGA contact pads" }, undefined, () => {}, ctx());
		assert.equal(rejectedLga.details.ok, false);
		assert.match(rejectedLga.content[0].text, /BGA solder balls/i);
		assert.equal(fetches, beforeMismatch, "mismatched preview must not be downloaded");
		assert.equal(reviews.length, 1, "explicit package contradiction is rejected before model review");

		// Ambiguous metadata still has to pass an image-capable reviewer.
		const opaque = await search.execute("opaque", { query: "CPU rear view", needed_view: "the BGA solder ball grid on the package underside", learning_goal: "how solder balls connect the package to its circuit board" }, undefined, () => {}, ctx());
		assert.equal(opaque.details.count, 1);
		reviewerVerdict = "mismatch";
		const beforeReview = fetches;
		const rejectedByVision = await importer.execute("vision", { candidate_id: "44", what_to_notice: "Notice the package contact pattern on its underside.", alt_text: "CPU underside showing an array of package contacts" }, undefined, () => {}, ctx());
		assert.equal(rejectedByVision.details.ok, false);
		assert.match(rejectedByVision.content[0].text, /not imported/i);
		assert.equal(fetches, beforeReview, "failed visual review must not download or write an image");
		assert.match(reviews.at(-1).context.messages[0].content[0].text, /Original visual need:.*BGA solder ball/i);

		const beforeReset = fetches;
		const dilutedReset = await search.execute("bad-reset", { query: "full-face contacts", needed_view: "the grid of package contacts across the board side", learning_goal: "how package contacts connect to the circuit board", start_new_goal: true, new_goal_reason: "Moving to another visual goal after failed search" }, undefined, () => {}, ctx());
		assert.equal(dilutedReset.details.count, 0);
		assert.match(dilutedReset.content[0].text, /broader restatement/);
		assert.equal(fetches, beforeReset);

		reviewerVerdict = "match";
		const newNode = await search.execute("new-node", { query: "silicon interposer", needed_view: "a cross-section of silicon interposer microbump connections", learning_goal: "how an interposer links separate chiplets", start_new_goal: true, new_goal_reason: "The BGA image search failed; the lesson has moved to the interposer node." }, undefined, () => {}, ctx());
		assert.equal(newNode.details.count, 1, "a distinct later lesson node can begin a fresh visual goal");
		const newNodeImport = await importer.execute("new-node-import", { candidate_id: "42", what_to_notice: "NOTICE: the array of tiny vertical connections between the chiplet and interposer.", alt_text: "Cross-section showing microbump connections on a silicon interposer" }, undefined, () => {}, ctx());
		assert.equal(newNodeImport.details.ok, true);
		assert.match(newNodeImport.details.block, /\*Notice: the array of tiny vertical connections between the chiplet and interposer\.\*/);
		assert.match(reviews.at(-1).context.messages[0].content[0].text, /The BGA image search failed; the lesson has moved to the interposer node/);

		await search.execute("no-model", { query: "BGA package underside", needed_view: "the BGA solder ball grid on the package underside", learning_goal: "how solder balls connect the package to its circuit board" }, undefined, () => {}, ctx());
		const unavailable = await importer.execute("no-reviewer", { candidate_id: "42", what_to_notice: "Notice the solder balls arrayed across the package underside.", alt_text: "BGA package underside with solder balls arranged in a grid" }, undefined, () => {}, { ...ctx(), modelRegistry: null });
		assert.equal(unavailable.details.ok, false, "unavailable image review must fail closed");
		assert.match(unavailable.content[0].text, /reviewer is unavailable/);
	} finally {
		session?.dispose();
		globalThis.fetch = originalFetch;
	}
});
