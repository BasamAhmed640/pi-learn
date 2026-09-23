import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureLearnStyle, findVaultRoot, shippedCss, SNIPPET_NAME } from "../../extensions/lib/obsidian-style.ts";

function vault() {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-style-"));
	mkdirSync(join(root, ".obsidian"), { recursive: true });
	mkdirSync(join(root, "Learn", "Deep"), { recursive: true });
	const note = join(root, "Learn", "Deep", "Topic.md");
	writeFileSync(note, "# t\n");
	return { root, note };
}

test("shipped CSS centers callouts, display math and mermaid, scoped to .pi-learn", () => {
	const css = shippedCss();
	for (const selector of [".pi-learn .callout", ".pi-learn .math-block", 'mjx-container.MathJax[display="true"]', ".pi-learn .mermaid", ".pi-learn .mermaid > svg"]) {
		assert.ok(css.includes(selector), selector);
	}
	assert.match(css, /margin-inline: auto/);
	assert.match(css, /justify-content: center/);
	// Every rule is scoped so other notes in the vault are untouched.
	const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").slice(0, -1).map((s) => s.split("}").pop().trim());
	for (const sel of selectors) for (const part of sel.split(",")) assert.ok(part.trim().startsWith(".pi-learn"), `unscoped selector: ${part}`);
});

test("findVaultRoot walks up to the folder that holds .obsidian", () => {
	const { root, note } = vault();
	assert.equal(findVaultRoot(note), root);
	assert.equal(findVaultRoot(join(tmpdir(), "definitely-not-a-vault-xyz", "a.md")), undefined);
});

test("first install writes the snippet, receipt and enables it without dropping other snippets", async () => {
	const { root, note } = vault();
	writeFileSync(join(root, ".obsidian", "appearance.json"), JSON.stringify({ theme: "obsidian", enabledCssSnippets: ["mine"] }));
	const result = await ensureLearnStyle(note, "/* v1 */ .pi-learn .callout{margin-inline:auto}");
	assert.equal(result.status, "installed");
	assert.equal(readFileSync(join(root, ".obsidian", "snippets", `${SNIPPET_NAME}.css`), "utf8"), "/* v1 */ .pi-learn .callout{margin-inline:auto}");
	const appearance = JSON.parse(readFileSync(join(root, ".obsidian", "appearance.json"), "utf8"));
	assert.deepEqual(appearance.enabledCssSnippets, ["mine", "pi-learn"]);
	assert.equal(appearance.theme, "obsidian");
	assert.equal((await ensureLearnStyle(note, "/* v1 */ .pi-learn .callout{margin-inline:auto}")).status, "current");
});

test("a newer release replaces its own snippet but never a customised one, and never re-enables", async () => {
	const { root, note } = vault();
	await ensureLearnStyle(note, "/* v1 */");
	// The learner turns the snippet off; an update must respect that.
	const appearancePath = join(root, ".obsidian", "appearance.json");
	writeFileSync(appearancePath, JSON.stringify({ enabledCssSnippets: [] }));
	assert.equal((await ensureLearnStyle(note, "/* v2 */")).status, "updated");
	assert.equal(readFileSync(join(root, ".obsidian", "snippets", "pi-learn.css"), "utf8"), "/* v2 */");
	assert.deepEqual(JSON.parse(readFileSync(appearancePath, "utf8")).enabledCssSnippets, []);
	writeFileSync(join(root, ".obsidian", "snippets", "pi-learn.css"), "/* my tweaks */");
	const customised = await ensureLearnStyle(note, "/* v3 */");
	assert.equal(customised.status, "customized");
	assert.equal(readFileSync(join(root, ".obsidian", "snippets", "pi-learn.css"), "utf8"), "/* my tweaks */");
});

test("no vault or broken appearance.json never throws", async () => {
	const outside = mkdtempSync(join(tmpdir(), "pi-learn-novault-"));
	assert.equal((await ensureLearnStyle(join(outside, "a.md"), "x")).status, "no-vault");
	const { root, note } = vault();
	writeFileSync(join(root, ".obsidian", "appearance.json"), "{ not json");
	const result = await ensureLearnStyle(note, "/* v1 */");
	assert.equal(result.status, "installed");
	assert.match(result.message, /enable the snippet/);
	assert.equal(readFileSync(join(root, ".obsidian", "appearance.json"), "utf8"), "{ not json", "left unchanged");
});
