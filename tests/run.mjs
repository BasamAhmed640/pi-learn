// Runs every *.test.mjs under tests/unit and tests/integration with node:test.
// End-to-end sessions (tests/e2e) and Obsidian render checks (tests/obsidian)
// need a live model / a running Obsidian, so they are run explicitly instead.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const files = [];
for (const dir of ["unit", "integration"]) {
	const full = join(root, dir);
	if (!existsSync(full)) continue;
	for (const name of readdirSync(full).sort()) {
		if (name.endsWith(".test.mjs")) files.push(join(full, name));
	}
}
if (files.length === 0) {
	console.error("No tests found under tests/unit or tests/integration.");
	process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
