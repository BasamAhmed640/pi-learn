// Real Pi resource loading and tool activation, without a model call.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPiSdk, repoRoot } from "../helpers/pi.mjs";

test("pi-learn remains absent from plain model context until /learn links a note", async () => {
	const sdk = await importPiSdk();
	const root = mkdtempSync(join(tmpdir(), "pi-learn-containment-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	mkdirSync(join(cwd, ".obsidian"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }));
	const previousNotesDir = process.env.PI_LEARN_NOTES_DIR;
	process.env.PI_LEARN_NOTES_DIR = cwd;
	let session;
	try {
		const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, noContextFiles: true, noThemes: true, noPromptTemplates: true });
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		assert.ok(resourceLoader.getExtensions().extensions.some((ext) => ext.path.endsWith("obsidian-link.ts")));
		const skills = resourceLoader.getSkills().skills.map((skill) => skill.name);
		assert.ok(!skills.includes("teach") && !skills.includes("visualize"), "package does not globally export teaching skills");

		({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd) }));
		await session.bindExtensions({ mode: "print" });
		const active = () => session.getActiveToolNames();
		const lessonTools = ["quiz", "ask_user_question", "search_commons_images", "import_commons_image"];
		for (const name of lessonTools) assert.ok(!active().includes(name), `${name} leaked into ordinary chat`);
		for (const text of [...lessonTools, "LESSON SKILLS", "Wikimedia Commons"]) {
			assert.ok(!session.systemPrompt.includes(text), `${text} leaked into the ordinary system prompt`);
		}
		const runner = session.extensionRunner;
		const teach = runner.getRegisteredCommands().find((command) => command.name === "teach");
		const learn = runner.getRegisteredCommands().find((command) => command.name === "learn");
		assert.ok(teach && learn, "commands remain available");
		const note = join(cwd, "Lesson.md");
		writeFileSync(note, "");
		await learn.handler(`open "${note}"`, runner.createContext());
		for (const name of lessonTools) assert.ok(active().includes(name), `${name} did not activate for a lesson; active=${active().join(",")}; registered=${session.getAllTools().map((tool) => tool.name).join(",")}`);
		await learn.handler("close", runner.createContext());
		for (const name of lessonTools) {
			assert.ok(!active().includes(name), `${name} stayed active after closing`);
			assert.ok(!session.systemPrompt.includes(name), `${name} stayed in the prompt after closing`);
		}
	} finally {
		session?.dispose();
		if (previousNotesDir === undefined) delete process.env.PI_LEARN_NOTES_DIR;
		else process.env.PI_LEARN_NOTES_DIR = previousNotesDir;
		rmSync(root, { recursive: true, force: true });
	}
});
