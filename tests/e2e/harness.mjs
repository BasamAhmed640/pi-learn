// Run ONE learning session headlessly against a real model, with a simulated learner driving the
// real quiz / ask_user_question TUI components. Writes a trace JSON + a copy of the final note.
//
//   node tests/e2e/harness.mjs --scenario nonsys-prime [--run-id X] [--thinking medium]
//        [--model provider/id] [--realistic] [--vault DIR] [--max-user-turns N] [--p 0.7]
//        [--timeout-min 12] [--seed S]
//
// Usually launched by tests/e2e/run.mjs (one child process per scenario). The last stdout line
// is `E2E_RESULT {json}` so the parent can summarise without re-reading the trace.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importPiSdk, packageExtensionPaths, piVersion, repoRoot, skillsDir } from "../helpers/pi.mjs";
import { createSimulatedUI, makeRng } from "./learner.mjs";
import { getScenario } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VAULT = "C:\\Users\\basam\\Documents\\pi-learn-acceptance\\vault";
export const OUT_ROOT = join(here, "out");
export const PREFERENCE_LINE = "(Please keep the level probe to about 3 quick questions.)";
const APPROVAL_TEXT = "Looks good — go ahead.";
const CONTINUE_TEXT = "Continue.";
const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
		const next = argv[i + 1];
		if (inline !== undefined) out[k] = inline;
		else if (next !== undefined && !next.startsWith("--")) {
			out[k] = next;
			i++;
		} else out[k] = true;
	}
	return out;
}

export function defaultRunId() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
			: "";

function hasMermaid(text) {
	return /```mermaid\b/.test(text);
}
/** Does this assistant text present a plan and ask for the learner's go-ahead? */
export function isPlanPresentation(text) {
	if (!hasMermaid(text)) return false;
	// The reading-note layout presents the dependency map under a Learning path
	// heading, then asks for approval with ask_user_question. The question is a
	// separate tool call, so it need not appear as a `?` in assistant prose.
	if (/%%\s*dependency-map/.test(text) && /^#{2,3}\s+Learning path\b/im.test(text)) return true;
	if (/%%\s*dependency-map/.test(text) && /\?/.test(text)) return true;
	const tail = text.slice(-1200);
	return (
		/\?/.test(tail) &&
		/(go[- ]ahead|sound good|look good|looks right|okay|ok\b|shall (we|i)|ready to (start|begin|dive)|approve|does (this|that) (plan|work|match)|want me to|proceed|adjust|change anything|start with|begin with|plan)/i.test(
			tail,
		)
	);
}

// ── One session (one phase) ─────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.scenario   scenario with defaults applied
 * @param {string} o.runId
 * @param {string} o.phase      "main" | "A" | "B"
 * @param {string} o.notesDir
 * @param {string} o.sessionsDir
 * @param {string} o.thinking
 * @param {string} [o.model]    provider/id
 * @param {boolean} o.realistic
 * @param {string} o.vault     acceptance vault root
 * @param {number} o.maxUserTurns
 * @param {"topic"|"resume"} o.start
 * @param {string} [o.resumeNote]
 * @param {boolean} o.addPreference
 * @param {string} o.seed
 * @param {boolean} [o.inheritApproved]  resume phase: plan approval carried over from phase A
 */
export async function runSession(o) {
	const t0 = Date.now();
	const deadline = t0 + o.scenario.timeoutMin * 60_000;
	const trace = {
		phase: o.phase,
		startedAt: new Date(t0).toISOString(),
		finishedAt: null,
		durationMs: null,
		model: null,
		thinkingLevel: null,
		isolation: o.realistic ? "realistic" : "isolated",
		paths: { notesDir: o.notesDir, sessionsDir: o.sessionsDir, sessionFile: null, note: null },
		resources: {},
		driver: {
			startMode: null,
			approved: false,
			approvedAtTurn: null,
			approvedVia: null,
			planTurn: null,
			planMessageIds: [],
			quizChecksAfterPlan: 0,
			stopReason: null,
		},
		userPrompts: [],
		assistantMessages: [],
		toolCalls: [],
		customMessages: [],
		learnerDecisions: [],
		notifications: [],
		dialogs: [],
		commandActions: [],
		extensionErrors: [],
		errors: [],
		expectedAborts: [],
		timeline: [],
		turns: [],
	};
	const rec = (entry) => trace.timeline.push({ t: Date.now() - t0, ...entry });
	if (o.inheritApproved) {
		// Resumed session: the plan was already approved in the previous session.
		trace.driver.approved = true;
		trace.driver.approvedVia = "previous-session";
	}

	mkdirSync(o.notesDir, { recursive: true });
	mkdirSync(join(o.vault, ".obsidian"), { recursive: true });
	mkdirSync(o.sessionsDir, { recursive: true });
	process.env.PI_LEARN_NOTES_DIR = o.notesDir;

	const sdk = await importPiSdk();
	const { createAgentSession, DefaultResourceLoader, SessionManager, ModelRuntime, getAgentDir } = sdk;
	const agentDir = getAgentDir();

	// Package extensions that exist right now (others may still be under construction).
	const declared = packageExtensionPaths();
	const extPaths = declared.filter((p) => existsSync(p));
	trace.resources.missingExtensions = declared.filter((p) => !existsSync(p)).map((p) => p.replace(repoRoot, "."));

	// Harness-only inline extension: appends the learner's preference line to the first real
	// user message, whether we type it or a command (e.g. /learn) sends it via sendUserMessage.
	let preferenceAdded = !o.addPreference;
	const learnerPreferenceExtension = (pi) => {
		pi.on("input", async (event) => {
			if (preferenceAdded) return { action: "continue" };
			const text = String(event.text ?? "");
			if (!text.trim() || (text.startsWith("/") && !text.startsWith("/skill:"))) return { action: "continue" };
			preferenceAdded = true;
			return { action: "transform", text: `${text}\n\n${PREFERENCE_LINE}`, images: event.images };
		});
	};

	const loaderOptions = o.realistic
		? {
				cwd: o.notesDir,
				agentDir,
				additionalExtensionPaths: extPaths,
				additionalSkillPaths: [skillsDir],
				extensionFactories: [learnerPreferenceExtension],
			}
		: {
				cwd: o.notesDir,
				agentDir,
				noExtensions: true,
				additionalExtensionPaths: extPaths,
				noSkills: true,
				additionalSkillPaths: [skillsDir],
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [learnerPreferenceExtension],
			};
	const resourceLoader = new DefaultResourceLoader(loaderOptions);
	await resourceLoader.reload();
	const ext = resourceLoader.getExtensions();
	trace.resources.extensions = ext.extensions.map((e) => e.path);
	trace.resources.extensionLoadErrors = ext.errors;
	trace.resources.skills = resourceLoader.getSkills().skills.map((s) => s.name);
	trace.resources.contextFiles = resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path);

	let modelRuntime;
	let model;
	if (o.model) {
		const slash = o.model.indexOf("/");
		if (slash <= 0) throw new Error(`--model must be provider/id, got "${o.model}"`);
		modelRuntime = await ModelRuntime.create({ agentDir });
		model = modelRuntime.getModel(o.model.slice(0, slash), o.model.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${o.model}`);
	}

	const sessionManager = SessionManager.create(o.notesDir, o.sessionsDir);
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: o.notesDir,
		agentDir,
		resourceLoader,
		sessionManager,
		thinkingLevel: o.thinking,
		...(model ? { model, modelRuntime } : {}),
	});
	if (modelFallbackMessage) trace.errors.push({ at: Date.now() - t0, where: "model", message: modelFallbackMessage });
	try {
		if (session.thinkingLevel !== o.thinking && typeof session.setThinkingLevel === "function") session.setThinkingLevel(o.thinking);
	} catch {
		/* model may not support it */
	}
	trace.model = session.model ? `${session.model.provider}/${session.model.id}` : null;
	// Models clamp unsupported levels (e.g. a low/high/max model turns "medium" into "high").
	trace.thinkingRequested = o.thinking;
	trace.thinkingLevel = session.thinkingLevel ?? o.thinking;
	try {
		trace.availableThinkingLevels = session.getAvailableThinkingLevels();
	} catch {
		/* optional */
	}
	if (trace.thinkingLevel !== o.thinking) {
		console.error(`[e2e] thinking "${o.thinking}" not supported by ${trace.model}; effective level: ${trace.thinkingLevel} (available: ${(trace.availableThinkingLevels || []).join(", ")})`);
	}
	trace.paths.sessionFile = session.sessionFile ?? null;
	trace.sessionId = session.sessionId;

	// ── Event capture ──
	const pending = new Map(); // toolCallId -> { id, name, args, shuffled }
	const callsById = new Map();
	let currentTurn = 0;
	let agentStarts = 0;
	let abortRequested = false;
	let turnsSinceQuizLimit = 0;
	session.subscribe((ev) => {
		try {
			switch (ev.type) {
				case "agent_start":
					agentStarts++;
					break;
				case "message_end": {
					const m = ev.message;
					if (!m || !("role" in m)) break;
					if (m.role === "assistant") {
						const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n\n").trim();
						const toolCalls = (m.content || []).filter((c) => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name }));
						const entry = {
							index: trace.assistantMessages.length,
							at: Date.now() - t0,
							turn: currentTurn,
							text,
							toolCalls,
							stopReason: m.stopReason,
							errorMessage: m.errorMessage,
							usage: m.usage ? { input: m.usage.input, output: m.usage.output, totalTokens: m.usage.totalTokens } : undefined,
							mermaidBlocks: (text.match(/```mermaid\b/g) || []).length,
						};
						trace.assistantMessages.push(entry);
						rec({ kind: "assistant", index: entry.index, chars: text.length, toolCalls: toolCalls.map((c) => c.name), stopReason: m.stopReason });
						if (m.stopReason === "error" || m.stopReason === "aborted" || m.errorMessage) {
							const e = { at: entry.at, where: "assistant", message: m.errorMessage || `stopReason=${m.stopReason}` };
							// The driver's own mid-run stop (quiz budget) aborts the request on purpose.
							if (abortRequested) trace.expectedAborts.push(e);
							else trace.errors.push(e);
						}
						if (!trace.driver.approved && trace.driver.planTurn === null && isPlanPresentation(text)) {
							trace.driver.planTurn = currentTurn;
						}
						if (!trace.driver.approved && isPlanPresentation(text)) trace.driver.planMessageIds.push(entry.index);
					} else if (m.role === "user") {
						rec({ kind: "user-message", text: textOf(m.content).slice(0, 400) });
					} else if (m.role === "custom") {
						const c = { at: Date.now() - t0, turn: currentTurn, customType: m.customType, display: m.display, text: textOf(m.content), details: m.details };
						trace.customMessages.push(c);
						rec({ kind: "custom", customType: m.customType, text: c.text.slice(0, 300) });
					} else if (m.role !== "toolResult") {
						rec({ kind: `message:${m.role}` });
					}
					break;
				}
				case "tool_execution_start": {
					const call = {
						id: ev.toolCallId,
						name: ev.toolName,
						args: ev.args,
						turn: currentTurn,
						startedAt: Date.now() - t0,
						afterApproval: trace.driver.approved,
						updates: 0,
					};
					callsById.set(call.id, call);
					trace.toolCalls.push(call);
					if (QA_TOOLS.has(ev.toolName)) pending.set(ev.toolCallId, { id: ev.toolCallId, name: ev.toolName, args: ev.args });
					rec({ kind: "tool-start", name: ev.toolName, id: ev.toolCallId });
					break;
				}
				case "tool_execution_update": {
					const call = callsById.get(ev.toolCallId);
					if (call) call.updates++;
					const p = pending.get(ev.toolCallId);
					const shuffled = ev.partialResult?.details?.options;
					if (p && Array.isArray(shuffled)) p.shuffled = shuffled;
					break;
				}
				case "tool_execution_end": {
					const call = callsById.get(ev.toolCallId);
					pending.delete(ev.toolCallId);
					if (!call) break;
					const details = ev.result?.details;
					call.endedAt = Date.now() - t0;
					call.isError = !!ev.isError;
					call.resultText = textOf(ev.result?.content);
					call.details = details;
					call.status = details?.status;
					// A blocked call (extension tool_call handler returned block) ends as an error without executing.
					call.blocked = !!ev.isError && !(details && details.status);
					call.executed = QA_TOOLS.has(call.name) ? !ev.isError && !!details?.status : !ev.isError;
					if (call.name === "quiz" && call.executed && trace.driver.approved) trace.driver.quizChecksAfterPlan++;
					// Approval given through a tool: the tutor asked "shall we start?" via ask_user_question.
					if (
						call.name === "ask_user_question" &&
						call.executed &&
						!trace.driver.approved &&
						trace.driver.planTurn !== null &&
						/(plan|learning path|shall we|follow this|go ahead|proceed|start|begin|sound|look good|approve|ready)/i.test(String(call.args?.question ?? ""))
					) {
						trace.driver.approved = true;
						trace.driver.approvedAtTurn = currentTurn;
						trace.driver.approvedVia = "ask_user_question";
					}
					rec({ kind: "tool-end", name: call.name, id: call.id, blocked: call.blocked, executed: call.executed });
					break;
				}
				case "turn_end": {
					// The tutor may teach several nodes inside one run. Once the post-plan quiz budget is
					// spent, let the tutor react to that last answer (one more turn), then stop the run.
					if (trace.driver.approved && trace.driver.quizChecksAfterPlan >= o.scenario.maxQuizChecksAfterPlan && !abortRequested) {
						turnsSinceQuizLimit++;
						if (turnsSinceQuizLimit >= 2) {
							abortRequested = true;
							trace.driver.abortedMidRun = true;
							rec({ kind: "driver-abort", reason: "maxQuizChecksAfterPlan" });
							setImmediate(() => session.abort().catch(() => {}));
						}
					}
					break;
				}
				case "auto_retry_start":
					rec({ kind: "retry", attempt: ev.attempt, error: ev.errorMessage });
					break;
				case "compaction_start":
					rec({ kind: "compaction", reason: ev.reason });
					break;
				default:
					break;
			}
		} catch (err) {
			trace.errors.push({ at: Date.now() - t0, where: "event-capture", message: String(err?.stack || err) });
		}
	});

	// ── Simulated UI ──
	const rng = makeRng(o.seed);
	const sim = createSimulatedUI({
		rng,
		p: o.scenario.p,
		dontKnowRate: o.scenario.dontKnowRate,
		goal: o.scenario.goal,
		pendingCalls: () => pending,
		record: (e) => rec(e),
		width: 100,
	});
	trace.learnerDecisions = sim.decisions;
	trace.notifications = sim.notifications;
	trace.dialogs = sim.dialogs;
	trace.uiStatuses = sim.statuses;

	const unsupported = (name) => async () => {
		trace.commandActions.push({ at: Date.now() - t0, action: name });
		return { cancelled: true };
	};
	await session.bindExtensions({
		uiContext: sim.ui,
		mode: "tui",
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: unsupported("newSession"),
			fork: unsupported("fork"),
			navigateTree: unsupported("navigateTree"),
			switchSession: unsupported("switchSession"),
			reload: async () => {
				trace.commandActions.push({ at: Date.now() - t0, action: "reload" });
			},
		},
		shutdownHandler: () => trace.commandActions.push({ at: Date.now() - t0, action: "shutdown" }),
		onError: (err) => trace.extensionErrors.push({ at: Date.now() - t0, ...err }),
	});
	const commands = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName ?? c.name);
	trace.resources.commands = commands;
	try {
		trace.resources.activeTools = session.getActiveToolNames?.() ?? undefined;
	} catch {
		/* optional */
	}

	// ── Driver ──
	async function settle(graceMs) {
		let idleSince = null;
		for (;;) {
			if (Date.now() > deadline) return "timeout";
			if (!session.isIdle) {
				idleSince = null;
				const remaining = deadline - Date.now();
				const timedOut = await Promise.race([session.waitForIdle().then(() => false), sleep(Math.max(0, remaining)).then(() => true)]);
				if (timedOut) return "timeout";
				continue;
			}
			if (idleSince === null) idleSince = Date.now();
			if (Date.now() - idleSince >= graceMs) return "idle";
			await sleep(100);
		}
	}

	async function send(text, { isCommand = false } = {}) {
		currentTurn++;
		const startedAt = Date.now() - t0;
		trace.userPrompts.push({ turn: currentTurn, text, at: startedAt });
		rec({ kind: "user", turn: currentTurn, text });
		const startsBefore = agentStarts;
		try {
			const remaining = deadline - Date.now();
			const outcome = await Promise.race([
				session.prompt(text).then(() => "done"),
				sleep(Math.max(0, remaining)).then(() => "timeout"),
			]);
			if (outcome === "timeout") return "timeout";
		} catch (err) {
			trace.errors.push({ at: Date.now() - t0, where: `prompt(turn ${currentTurn})`, message: String(err?.message || err) });
		}
		// A command may start the agent asynchronously (pi.sendUserMessage); give it time to begin.
		if (isCommand) {
			const waitUntil = Date.now() + 5000;
			while (agentStarts === startsBefore && session.isIdle && Date.now() < waitUntil) await sleep(100);
		}
		const s = await settle(isCommand ? 2500 : 1500);
		trace.turns.push({ turn: currentTurn, text, startedAt, durationMs: Date.now() - t0 - startedAt, agentRuns: agentStarts - startsBefore });
		return s;
	}

	function assistantTextSince(turn) {
		return trace.assistantMessages.filter((m) => m.turn === turn).map((m) => m.text).join("\n\n");
	}

	let stopReason = null;
	try {
		// First message.
		if (!commands.includes("learn")) throw new Error("pi-learn /learn command is not loaded");
		if (commands.includes("md-log") || commands.includes("md-unlog")) throw new Error("retired note-logging commands are still loaded");
		let first;
		if (o.start === "resume") {
			trace.driver.startMode = "learn-resume-command";
			first = await send(`/learn resume "${o.resumeNote}"`, { isCommand: true });
		} else {
			trace.driver.startMode = "learn-command";
			first = await send(`/learn new ${o.scenario.topic}`, { isCommand: true });
		}
		if (first === "timeout") stopReason = "timeout";

		while (!stopReason) {
			const userTurns = trace.userPrompts.length;
			if (userTurns >= o.maxUserTurns) {
				stopReason = "maxUserTurns";
				break;
			}
			if (trace.driver.approved && trace.driver.quizChecksAfterPlan >= o.scenario.maxQuizChecksAfterPlan) {
				stopReason = "maxQuizChecksAfterPlan";
				break;
			}
			if (Date.now() > deadline) {
				stopReason = "timeout";
				break;
			}
			const lastText = assistantTextSince(currentTurn);
			let next = CONTINUE_TEXT;
			if (!trace.driver.approved && isPlanPresentation(lastText)) {
				next = APPROVAL_TEXT;
				trace.driver.approved = true;
				trace.driver.approvedAtTurn = currentTurn + 1;
				trace.driver.approvedVia = "message";
			}
			const r = await send(next);
			if (r === "timeout") stopReason = "timeout";
		}
	} catch (err) {
		stopReason = "error";
		trace.errors.push({ at: Date.now() - t0, where: "driver", message: String(err?.stack || err) });
	}
	if (stopReason === "timeout") {
		try {
			await Promise.race([session.abort(), sleep(10_000)]);
		} catch {
			/* ignore */
		}
	}
	trace.driver.stopReason = stopReason;

	// ── Locate the note ──
	let note = globalThis.__piLearn?.linkedNote || null;
	if (!note) {
		for (const e of session.sessionManager.getEntries()) {
			if (e.type === "custom" && e.customType === "learn-link" && e.data?.file) note = e.data.file;
		}
	}
	if (!note) note = newestNote(o.notesDir);
	trace.paths.note = note;
	trace.finishedAt = new Date().toISOString();
	trace.durationMs = Date.now() - t0;
	try {
		session.dispose();
	} catch {
		/* ignore */
	}
	return trace;
}

function newestNote(dir) {
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".md") && f !== "Learn Index.md")
		.map((f) => join(dir, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return files[0] ?? null;
}

// ── Scenario orchestration ─────────────────────────────────────────────────

export function summarize(trace) {
	const phases = trace.phases ?? [trace];
	const calls = phases.flatMap((p) => p.toolCalls);
	const qa = calls.filter((c) => QA_TOOLS.has(c.name));
	return {
		scenario: trace.scenario.id,
		kind: trace.scenario.kind,
		ok: phases.every((p) => p.driver.stopReason !== "error") && !trace.fatal,
		stopReason: phases.map((p) => p.driver.stopReason).join("+"),
		userTurns: phases.reduce((n, p) => n + p.userPrompts.length, 0),
		qaExecuted: qa.filter((c) => c.executed).length,
		qaBlocked: qa.filter((c) => c.blocked).length,
		quizExecuted: qa.filter((c) => c.name === "quiz" && c.executed).length,
		approved: phases.some((p) => p.driver.approved),
		mermaidInAssistant: phases.reduce((n, p) => n + p.assistantMessages.reduce((k, m) => k + m.mermaidBlocks, 0), 0),
		learnerInconsistent: phases.flatMap((p) => p.learnerDecisions).filter((d) => d.consistent === false || d.error).length,
		errors: phases.reduce((n, p) => n + p.errors.length + p.extensionErrors.length, 0) + (trace.fatal ? 1 : 0),
		durationMs: trace.durationMs,
		model: phases[0]?.model,
		thinking: phases[0]?.thinkingLevel,
		trace: trace.tracePath,
		note: trace.noteCopy,
	};
}

function resumeVerdict(a, b) {
	const qNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
	const jacc = (x, y) => {
		const X = new Set(qNorm(x));
		const Y = new Set(qNorm(y));
		if (!X.size || !Y.size) return 0;
		let inter = 0;
		for (const w of X) if (Y.has(w)) inter++;
		return inter / (X.size + Y.size - inter);
	};
	const aProbe = a.toolCalls.filter((c) => c.name === "quiz" && c.executed && !c.afterApproval).map((c) => c.args?.question);
	const bFirstRun = b.toolCalls.filter((c) => c.turn <= 1);
	const bQuizzesFirstRun = bFirstRun.filter((c) => c.name === "quiz" && c.executed);
	const repeated = bQuizzesFirstRun.filter((c) => aProbe.some((q) => jacc(q, c.args?.question) >= 0.5)).length;
	const bFirstText = b.assistantMessages.filter((m) => m.turn <= 2).map((m) => m.text).join("\n");
	const refersBack = /(last time|previous(ly)? session|where we left off|pick(ing)? up|resum|continu|so far we|we('ve| have) (covered|established))/i.test(bFirstText);
	const bNewPlanBeforeTeaching = b.assistantMessages.some((m) => m.turn <= 2 && isPlanPresentation(m.text));
	const aHadPlan = a.driver.planTurn !== null;
	const bAskedGoal = bFirstRun.some((c) => c.name === "ask_user_question" && c.executed);
	let verdict = "unclear";
	if (repeated >= 2 || (bQuizzesFirstRun.length >= 3 && !refersBack) || (aHadPlan && bNewPlanBeforeTeaching && bAskedGoal)) verdict = "restarted-probe";
	else if (refersBack || (bQuizzesFirstRun.length <= 1 && !bAskedGoal)) verdict = "continued";
	return {
		verdict,
		signals: { refersBack, quizzesInFirstResumeRun: bQuizzesFirstRun.length, repeatedProbeQuestions: repeated, askedGoalAgain: bAskedGoal, newPlanBeforeTeaching: bNewPlanBeforeTeaching, phaseAHadPlan: aHadPlan },
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.scenario) {
		console.error("usage: node tests/e2e/harness.mjs --scenario <id> [--run-id X] [--thinking medium] [--model p/id] [--realistic] [--vault DIR] [--max-user-turns N]");
		process.exit(2);
	}
	const scenario = getScenario(args.scenario);
	if (args.p !== undefined) scenario.p = Number(args.p);
	if (args["timeout-min"] !== undefined) scenario.timeoutMin = Number(args["timeout-min"]);
	if (args["max-quiz-checks"] !== undefined) scenario.maxQuizChecksAfterPlan = Number(args["max-quiz-checks"]);
	const runId = String(args["run-id"] || defaultRunId());
	const vault = resolve(String(args.vault || process.env.PI_LEARN_E2E_VAULT || DEFAULT_VAULT));
	const outDir = join(OUT_ROOT, runId);
	mkdirSync(outDir, { recursive: true });
	const notesDir = join(vault, "Learn", runId, scenario.id);
	const common = {
		scenario,
		runId,
		vault,
		thinking: String(args.thinking || "medium"),
		model: args.model ? String(args.model) : undefined,
		realistic: !!args.realistic,
		notesDir,
		seed: String(args.seed || `${runId}:${scenario.id}`),
	};
	const maxTurnsOverride = args["max-user-turns"] !== undefined ? Number(args["max-user-turns"]) : undefined;
	const tracePath = join(outDir, `${scenario.id}.json`);
	const noteCopy = join(outDir, `${scenario.id}.md`);

	// Phase B of a resume scenario runs in its own process (fresh extension module state).
	if (args.phase === "B") {
		const trace = await runSession({
			...common,
			phase: "B",
			sessionsDir: join(outDir, "sessions", `${scenario.id}-B`),
			maxUserTurns: maxTurnsOverride ?? scenario.phaseB?.maxUserTurns ?? 3,
			start: "resume",
			resumeNote: String(args.note),
			addPreference: false,
			inheritApproved: !!args["inherit-approved"],
			seed: `${common.seed}:B`,
		});
		writeFileSync(String(args["phase-out"]), JSON.stringify(trace, null, 2));
		process.exit(0);
	}

	const t0 = Date.now();
	const top = {
		runId,
		scenario,
		piVersion,
		vault,
		startedAt: new Date(t0).toISOString(),
		tracePath,
		noteCopy: null,
		fatal: null,
	};
	let final;
	try {
		if (scenario.kind === "resume") {
			const a = await runSession({
				...common,
				phase: "A",
				sessionsDir: join(outDir, "sessions", `${scenario.id}-A`),
				maxUserTurns: maxTurnsOverride ?? scenario.phaseA?.maxUserTurns ?? 3,
				start: "topic",
				addPreference: true,
			});
			const phaseOut = join(outDir, `${scenario.id}.phaseB.tmp.json`);
			let b = null;
			if (a.paths.note && existsSync(a.paths.note)) {
				const childArgs = [fileURLToPath(import.meta.url), "--scenario", scenario.id, "--phase", "B", "--run-id", runId, "--vault", vault, "--note", a.paths.note, "--phase-out", phaseOut, "--thinking", common.thinking, "--seed", common.seed];
				if (common.model) childArgs.push("--model", common.model);
				if (common.realistic) childArgs.push("--realistic");
				for (const k of ["timeout-min", "max-user-turns", "max-quiz-checks", "p"]) {
					if (args[k] !== undefined && args[k] !== true) childArgs.push(`--${k}`, String(args[k]));
				}
				if (a.driver.approved) childArgs.push("--inherit-approved");
				const code = await new Promise((res) => {
					const child = spawn(process.execPath, childArgs, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
					child.on("exit", (c) => res(c));
				});
				if (existsSync(phaseOut)) {
					b = JSON.parse(readFileSync(phaseOut, "utf8"));
				} else {
					a.errors.push({ where: "resume", message: `phase B exited with code ${code} and wrote no trace` });
				}
			} else {
				a.errors.push({ where: "resume", message: "phase A produced no note; phase B skipped" });
			}
			const phases = b ? [a, b] : [a];
			final = {
				...top,
				phases,
				resume: b ? resumeVerdict(a, b) : { verdict: "not-run" },
				paths: { note: (b ?? a).paths.note, notesDir },
				model: a.model,
			};
		} else {
			const t = await runSession({
				...common,
				phase: "main",
				sessionsDir: join(outDir, "sessions", scenario.id),
				maxUserTurns: maxTurnsOverride ?? scenario.maxUserTurns,
				start: "topic",
				addPreference: true,
			});
			final = { ...top, ...t, model: t.model };
		}
	} catch (err) {
		final = { ...top, fatal: String(err?.stack || err), phases: [] };
	}
	final.finishedAt = new Date().toISOString();
	final.durationMs = Date.now() - t0;
	const note = final.paths?.note;
	if (note && existsSync(note)) {
		copyFileSync(note, noteCopy);
		final.noteCopy = noteCopy;
	}
	writeFileSync(tracePath, JSON.stringify(final, null, 2));
	const summary = final.fatal
		? { scenario: scenario.id, kind: scenario.kind, ok: false, fatal: final.fatal.split("\n")[0], trace: tracePath }
		: summarize(final.phases ? final : { ...final, phases: undefined });
	process.stdout.write(`\nE2E_RESULT ${JSON.stringify(summary)}\n`);
	// Extensions or providers may keep handles open; the trace is written, so exit explicitly.
	process.exit(final.fatal ? 1 : 0);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err?.stack || err);
		process.exit(1);
	});
}
