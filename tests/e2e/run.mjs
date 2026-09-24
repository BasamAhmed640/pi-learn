// Run live-model e2e scenarios, each in its own child process (crash isolation), then analyze.
//
//   node tests/e2e/run.mjs --scenario <id|kind|all>[,...] [--parallel 3] [--run-id X]
//        [--thinking medium] [--model provider/id] [--realistic] [--vault DIR]
//        [--max-user-turns N] [--timeout-min M] [--no-analyze]
//
// Outputs land in tests/e2e/out/<runId>/: <scenario>.json (trace), <scenario>.md (final note),
// <scenario>.log (child stdout/stderr), sessions/, report.json + report.md.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_ROOT, defaultRunId, parseArgs } from "./harness.mjs";
import { selectScenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args.scenario || args.help) {
	console.log(
		"usage: node tests/e2e/run.mjs --scenario <id|kind|all> [--parallel 3] [--run-id X] [--thinking medium] [--model p/id] [--realistic] [--vault DIR] [--max-user-turns N] [--timeout-min M] [--no-analyze]",
	);
	process.exit(args.help ? 0 : 2);
}
const scenarios = selectScenarios(args.scenario);
const runId = String(args["run-id"] || defaultRunId());
const parallel = Math.max(1, Number(args.parallel || 3));
const outDir = join(OUT_ROOT, runId);
mkdirSync(outDir, { recursive: true });

const passthrough = [];
for (const k of ["thinking", "model", "vault", "max-user-turns", "max-quiz-checks", "timeout-min", "p", "seed"]) {
	if (args[k] !== undefined && args[k] !== true) passthrough.push(`--${k}`, String(args[k]));
}
if (args.realistic) passthrough.push("--realistic");

console.log(`run ${runId}: ${scenarios.length} scenario(s), parallel ${parallel} -> ${relative(process.cwd(), outDir) || outDir}`);

function runOne(s) {
	return new Promise((resolveRun) => {
		const t0 = Date.now();
		const log = createWriteStream(join(outDir, `${s.id}.log`));
		const child = spawn(process.execPath, [join(here, "harness.mjs"), "--scenario", s.id, "--run-id", runId, ...passthrough], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		child.stdout.on("data", (d) => {
			stdout += d;
			log.write(d);
		});
		child.stderr.on("data", (d) => log.write(d));
		// Hard ceiling: the harness enforces its own timeout; this only catches a wedged process.
		const hardMs = (Number(args["timeout-min"] || s.timeoutMin) * (s.kind === "resume" ? 2 : 1) + 5) * 60_000;
		const killer = setTimeout(() => child.kill(), hardMs);
		child.on("exit", (code, signal) => {
			clearTimeout(killer);
			log.end();
			const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("E2E_RESULT "));
			let result;
			try {
				result = line ? JSON.parse(line.slice("E2E_RESULT ".length)) : null;
			} catch {
				result = null;
			}
			if (!result) result = { scenario: s.id, kind: s.kind, ok: false, fatal: `child exited ${code ?? signal} without a result (see ${s.id}.log)` };
			result.wallMs = Date.now() - t0;
			printStatus(result);
			resolveRun(result);
		});
	});
}

function printStatus(r) {
	const secs = Math.round((r.wallMs ?? r.durationMs ?? 0) / 1000);
	if (r.fatal) {
		console.log(`ERR  ${r.scenario.padEnd(18)} ${secs}s  ${r.fatal}`);
		return;
	}
	const tag = r.ok && r.errors === 0 && r.learnerInconsistent === 0 ? "OK  " : r.ok ? "WARN" : "FAIL";
	console.log(
		`${tag} ${r.scenario.padEnd(18)} ${String(secs).padStart(4)}s  turns=${r.userTurns} qa=${r.qaExecuted}(blocked ${r.qaBlocked}) quiz=${r.quizExecuted} plan-approved=${r.approved ? "y" : "n"} mermaid=${r.mermaidInAssistant} errors=${r.errors} learner-mismatch=${r.learnerInconsistent} stop=${r.stopReason} model=${r.model} thinking=${r.thinking}`,
	);
}

const queue = [...scenarios];
const results = [];
await Promise.all(
	Array.from({ length: Math.min(parallel, queue.length) }, async () => {
		while (queue.length) results.push(await runOne(queue.shift()));
	}),
);

let acceptanceOk = true;
if (!args["no-analyze"]) {
	const { analyzeOutDir } = await import("./analyze.mjs");
	const report = await analyzeOutDir(outDir);
	const byId = new Map(report.scenarios.map((s) => [s.id, s]));
	acceptanceOk = report.summary.total === scenarios.length && scenarios.every((s) => byId.get(s.id)?.pass === true);
	console.log(`\nacceptance: ${report.summary.passed}/${report.summary.total} scenario(s) pass -> ${join(outDir, "report.md")}`);
}
const executionOk = results.length === scenarios.length && results.every((r) => r.ok && !r.fatal && !String(r.stopReason ?? "").includes("timeout"));
process.exit(executionOk && acceptanceOk ? 0 : 1);
