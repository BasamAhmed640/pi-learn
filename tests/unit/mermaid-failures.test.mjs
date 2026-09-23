// Infrastructure failures must fail open ({ status: "unavailable" }), never throw, and the worker
// must be recreated after a crash or timeout. Each case runs a private copy of mermaid.ts in a temp
// directory next to a real or stub mermaid-worker.mjs, so the module under test is unchanged.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/pi.mjs";

const lib = join(repoRoot, "extensions", "lib");
const dirs = [];

async function isolatedCopy(workerSource) {
	const dir = await mkdtemp(join(tmpdir(), "pi-learn-mermaid-fail-"));
	dirs.push(dir);
	await copyFile(join(lib, "mermaid.ts"), join(dir, "mermaid.ts"));
	if (workerSource === null) await copyFile(join(lib, "mermaid-worker.mjs"), join(dir, "mermaid-worker.mjs"));
	else if (workerSource !== undefined) await writeFile(join(dir, "mermaid-worker.mjs"), workerSource);
	return { dir, mod: await import(pathToFileURL(join(dir, "mermaid.ts")).href) };
}

after(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("missing worker file -> unavailable", async () => {
	const { mod } = await isolatedCopy(undefined);
	const result = await mod.validateMermaid("flowchart LR\n  A --> B");
	assert.equal(result.status, "unavailable");
	assert.equal(typeof result.error, "string");
});

test("mermaid/linkedom not installed -> unavailable", async (t) => {
	const { dir, mod } = await isolatedCopy(null);
	try {
		createRequire(join(dir, "x.js")).resolve("linkedom");
		t.skip("a linkedom install is reachable from the temp directory");
		return;
	} catch {
		/* expected: nothing to resolve */
	}
	const result = await mod.validateMermaid("flowchart LR\n  A --> B");
	assert.equal(result.status, "unavailable");
	assert.match(result.error, /could not be loaded/);
});

test("worker crash -> unavailable, then the worker is recreated", async () => {
	const { mod } = await isolatedCopy(`
import { parentPort } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
const marker = new URL("./crashed", import.meta.url);
parentPort.on("message", ({ id }) => {
	if (!existsSync(marker)) { writeFileSync(marker, "1"); throw new Error("boom"); }
	parentPort.postMessage({ id, status: "valid", diagramType: "stub" });
});
`);
	const first = await mod.validateMermaid("crash me");
	assert.equal(first.status, "unavailable");
	assert.match(first.error, /boom|crashed|exited/);
	const second = await mod.validateMermaid("crash me");
	assert.deepEqual(second, { status: "valid", diagramType: "stub" });
});

test("hung worker -> unavailable after 10 s, then the worker is recreated", { timeout: 30_000 }, async () => {
	const { mod } = await isolatedCopy(`
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, source }) => {
	if (source === "hang") return;
	parentPort.postMessage({ id, status: "invalid", error: "stub says no" });
});
`);
	const started = Date.now();
	const hung = await mod.validateMermaid("hang");
	const elapsed = Date.now() - started;
	assert.equal(hung.status, "unavailable");
	assert.match(hung.error, /timed out/);
	assert.ok(elapsed >= 9_500 && elapsed < 15_000, `elapsed ${elapsed} ms`);
	assert.deepEqual(await mod.validateMermaid("next"), { status: "invalid", error: "stub says no" });
});
