import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { importPiLoader, repoRoot } from "../helpers/pi.mjs";

test("maker tool mappings are registered only after a lesson is linked", async () => {
	const previous = globalThis.__pi_interactive_subagents;
	const registered = [];
	globalThis.__pi_interactive_subagents = { registerToolExtension: (name) => registered.push(name) };
	try {
		const loader = await importPiLoader();
		const loaded = await loader.loadExtensions([join(repoRoot, "extensions", "visual-tools", "index.ts")], repoRoot, undefined, loader.createExtensionRuntime());
		assert.deepEqual(loaded.errors, []);
		const ext = loaded.extensions[0];
		let entries = [];
		const ctx = { sessionManager: { getEntries: () => entries } };
		for (const handler of ext.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		for (const handler of ext.handlers.get("before_agent_start") ?? []) await handler({ type: "before_agent_start" }, ctx);
		assert.deepEqual(registered, [], "ordinary chat does not register maker tools");
		entries = [{ type: "custom", customType: "learn-link", data: { file: "C:/vault/Learn/Lesson.md" } }];
		for (const handler of ext.handlers.get("before_agent_start") ?? []) await handler({ type: "before_agent_start" }, ctx);
		assert.deepEqual(registered, ["write_mermaid", "edit_mermaid", "render_mermaid", "write_svg", "edit_svg", "render_svg"]);
	} finally {
		if (previous === undefined) delete globalThis.__pi_interactive_subagents;
		else globalThis.__pi_interactive_subagents = previous;
	}
});
