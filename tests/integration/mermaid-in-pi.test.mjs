// Proves extensions/lib/mermaid.ts works when loaded through pi's real extension loader (jiti):
// the worker path resolves relative to the module, validation returns real parser verdicts, and
// no DOM globals leak onto pi's main thread.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { importPiLoader, piVersion, repoRoot } from "../helpers/pi.mjs";

const libUrl = pathToFileURL(join(repoRoot, "extensions", "lib", "mermaid.ts")).href;
let dir;
let extension;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-learn-mermaid-"));
	const extensionPath = join(dir, "mermaid-probe.ts");
	await writeFile(
		extensionPath,
		[
			`import { validateMermaid, describeMermaid, extractMermaidBlocks, OBSIDIAN_MERMAID_VERSION } from ${JSON.stringify(libUrl)};`,
			"",
			"export default function (pi: any) {",
			'\tpi.registerCommand("mermaid-probe", {',
			'\t\tdescription: "test-only mermaid probe",',
			"\t\thandler: async (args: string) => {",
			"\t\t\tconst blocks = extractMermaidBlocks(args);",
			"\t\t\tconst results = [];",
			"\t\t\tfor (const block of blocks) {",
			"\t\t\t\tresults.push({ validation: await validateMermaid(block.source), shape: describeMermaid(block.source) });",
			"\t\t\t}",
			"\t\t\treturn { version: OBSIDIAN_MERMAID_VERSION, results };",
			"\t\t},",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	const { loadExtensions, createExtensionRuntime } = await importPiLoader();
	const loaded = await loadExtensions([extensionPath], dir, undefined, createExtensionRuntime());
	assert.deepEqual(
		loaded.errors.map((e) => String(e.error)),
		[],
		`pi ${piVersion} failed to load the probe extension`,
	);
	assert.equal(loaded.extensions.length, 1);
	extension = loaded.extensions[0];
});

after(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

test("validateMermaid runs under pi's jiti loader (valid and invalid)", { timeout: 60_000 }, async () => {
	const command = extension.commands.get("mermaid-probe");
	assert.ok(command, "probe command registered");
	const markdown = [
		"Intro",
		"```mermaid",
		"flowchart LR",
		"%% system: Probe — overview",
		'  A["Fetch (PC)"] --> B[Decode] --> C[Execute]',
		"  C -.->|next| A",
		"```",
		"",
		"> [!abstract] PI",
		"> ```mermaid",
		"> flowchart LR",
		">   A[Foo (bar)] --> B",
		"> ```",
	].join("\n");
	const output = await command.handler(markdown, {});
	assert.equal(output.version, "11.13.0");
	assert.equal(output.results.length, 2);
	const [good, bad] = output.results;
	assert.deepEqual(good.validation, { status: "valid", diagramType: "flowchart-v2" });
	assert.equal(good.shape.diagramType, "flowchart");
	assert.deepEqual(good.shape.tag, { kind: "system", label: "Probe", level: "overview" });
	assert.equal(bad.validation.status, "invalid");
	assert.match(bad.validation.error, /line 2/);
});

test("no DOM globals leak onto the main thread", () => {
	assert.equal(typeof globalThis.window, "undefined");
	assert.equal(typeof globalThis.document, "undefined");
	assert.equal(typeof globalThis.DOMParser, "undefined");
});
