// Analyze an e2e run directory and score it against the acceptance criteria.
//
//   node tests/e2e/analyze.mjs tests/e2e/out/<runId>
//
// For every <scenario>.md + <scenario>.json pair: Mermaid blocks (dependency maps vs concept
// diagrams, validity, size), question/answer callouts vs QA tool calls that actually executed,
// quiz-explanation leaks into question callouts, wikilink/embed resolution against the vault,
// frontmatter and session sections. Writes report.json + report.md into the run directory.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

// ── Mermaid helpers (real lib when present, regex fallback otherwise) ─────────

async function loadMermaidLib() {
	const p = join(repoRoot, "extensions", "lib", "mermaid.ts");
	if (!existsSync(p)) return { lib: null, reason: "extensions/lib/mermaid.ts not present" };
	try {
		const lib = await import(pathToFileURL(p).href);
		if (typeof lib.extractMermaidBlocks !== "function" || typeof lib.validateMermaid !== "function") return { lib: null, reason: "mermaid.ts lacks extraction or validation" };
		return { lib, reason: null };
	} catch (err) {
		return { lib: null, reason: `import failed: ${err.message}` };
	}
}

function fallbackExtract(markdown) {
	const out = [];
	const re = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
	let m;
	while ((m = re.exec(markdown))) out.push({ source: m[1].replace(/\n$/, ""), start: m.index, end: m.index + m[0].length });
	return out;
}

function fallbackDescribe(source) {
	const lines = source.split("\n").map((l) => l.trim());
	const typeLine = lines.find((l) => l && !l.startsWith("%%")) ?? "";
	const diagramType = typeLine.split(/\s+/)[0] || "unknown";
	let tag;
	const dm = lines.find((l) => /^%%\s*dependency-map/.test(l));
	const sys = lines.find((l) => /^%%\s*system:/.test(l));
	if (dm) tag = { kind: "dependency-map" };
	else if (sys) {
		const body = sys.replace(/^%%\s*system:\s*/, "");
		tag = { kind: "system", label: body.split(/\s+[—-]\s+/)[0], level: /zoom/i.test(body) ? "zoom" : /overview/i.test(body) ? "overview" : undefined };
	}
	const body = lines.filter((l) => l && !l.startsWith("%%") && l !== typeLine);
	const edges = body.filter((l) => /(--|==|-\.|~~~|->>|-->>)/.test(l)).length;
	const ids = new Set();
	for (const l of body) for (const m of l.matchAll(/(?:^|[\s;&>-])([A-Za-z_][\w]*)\s*(?=[[({>]|\s*(?:--|==|-\.|&|$))/g)) ids.add(m[1]);
	for (const kw of ["subgraph", "end", "style", "classDef", "class", "click", "linkStyle", "direction"]) ids.delete(kw);
	return { diagramType, tag, nodes: ids.size, edges, approximate: true };
}

// ── Note parsing ────────────────────────────────────────────────────────────

/** Remove fenced code, inline code and %% comments %% (links there are not rendered). */
function stripNonRendered(md) {
	return md
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(/`[^`\n]*`/g, "");
}

function parseCallouts(md) {
	const lines = md.split(/\r?\n/);
	const callouts = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^>\s*\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		const body = [];
		let j = i + 1;
		while (j < lines.length && /^>/.test(lines[j])) {
			body.push(lines[j].replace(/^>\s?/, ""));
			j++;
		}
		callouts.push({ type: m[1].toLowerCase(), title: m[2].trim(), body: body.join("\n"), line: i + 1 });
	}
	return callouts;
}

const isQuestionCallout = (c) => c.type === "question" && /^(Quiz|Question)$/.test(c.title);
const isAnswerCallout = (c) =>
	(["success", "failure"].includes(c.type) && /^Quiz — /.test(c.title)) ||
	(c.type === "question" && /^Quiz — I don't know/.test(c.title)) ||
	(c.type === "warning" && /^(Quiz|Question) — /.test(c.title)) ||
	(c.type === "example" && /^Answer$/.test(c.title));

function headingsOf(md) {
	const hs = [];
	for (const line of stripNonRendered(md).split(/\r?\n/)) {
		const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (m) hs.push(m[1]);
	}
	return hs;
}
const normHeading = (h) => h.replace(/[[\]|#^:\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

function parseFrontmatter(md) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
	if (!m) return null;
	const fm = {};
	let key = null;
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (kv) {
			key = kv[1];
			const v = kv[2].trim();
			if (v === "") fm[key] = [];
			else if (/^\[.*\]$/.test(v)) fm[key] = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
			else fm[key] = v.replace(/^["']|["']$/g, "");
			continue;
		}
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && key) {
			if (!Array.isArray(fm[key])) fm[key] = [];
			fm[key].push(item[1].trim().replace(/^["']|["']$/g, ""));
		}
	}
	return fm;
}

function checkStructure(md, { createdByLearn = true } = {}) {
	const fm = parseFrontmatter(md);
	const required = ["learn-topic", "learn-status", "learn-created", "learn-updated", "learn-sessions"];
	const missingKeys = fm ? required.filter((k) => !(k in fm)) : required;
	const tags = fm ? [].concat(fm.tags ?? []) : [];
	const lines = md.split(/\r?\n/);
	const sections = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^## Session (\d+) \((\d{4}-\d{2}-\d{2})\)\s*$/.exec(lines[i]);
		if (!m) continue;
		const window = lines.slice(i + 1, i + 5).join("\n");
		const marker = /%% learn-session: (\S+) %%/.exec(window);
		const continues = /Continues \[\[#Session (\d+) \((\d{4}-\d{2}-\d{2})\)\]\]\./.exec(window);
		sections.push({ n: Number(m[1]), date: m[2], line: i + 1, sessionId: marker?.[1] ?? null, continues: continues ? Number(continues[1]) : null });
	}
	const sessionsList = fm && Array.isArray(fm["learn-sessions"]) ? fm["learn-sessions"] : [];
	const problems = [];
	if (!fm) problems.push("no frontmatter");
	if (missingKeys.length) problems.push(`missing frontmatter keys: ${missingKeys.join(", ")}`);
	// tags: [learn] is only promised on notes /learn creates (a /md-log-linked note keeps its own tags).
	if (fm && createdByLearn && !tags.includes("learn")) problems.push("tags lacks 'learn'");
	if (sections.length === 0) problems.push("no '## Session N (date)' sections");
	for (const s of sections) {
		if (!s.sessionId) problems.push(`Session ${s.n}: missing %% learn-session %% marker`);
		if (s.n > 1 && s.continues !== s.n - 1) problems.push(`Session ${s.n}: missing 'Continues [[#Session ${s.n - 1} (...)]].'`);
	}
	if (fm && sessionsList.length !== sections.length) problems.push(`learn-sessions has ${sessionsList.length} entries but note has ${sections.length} session sections`);
	return { frontmatter: fm, sections, sessionsListed: sessionsList.length, problems, ok: problems.length === 0 };
}

// ── Vault link resolution ───────────────────────────────────────────────────

function indexVault(vault) {
	const files = [];
	const walk = (dir, depth) => {
		if (depth > 12) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === ".obsidian" || e.name === ".trash" || e.name === "node_modules" || e.name === ".git") continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else files.push(p);
		}
	};
	if (vault && existsSync(vault)) walk(vault, 0);
	const byBase = new Map();
	for (const f of files) {
		const b = basename(f).toLowerCase();
		if (!byBase.has(b)) byBase.set(b, []);
		byBase.get(b).push(f);
	}
	return { files, byBase, vault };
}

function resolveTarget(index, target, sourceNote) {
	if (!target) return sourceNote;
	const t = target.replace(/\\/g, "/").trim();
	const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(t) && !/\.md$/i.test(t) ? true : false;
	const withExt = hasExt || /\.md$/i.test(t) ? t : `${t}.md`;
	if (t.includes("/")) {
		const p = join(index.vault, ...withExt.split("/"));
		if (existsSync(p)) return p;
		const rel = join(dirname(sourceNote), ...withExt.split("/"));
		if (existsSync(rel)) return rel;
	}
	const cands = index.byBase.get(basename(withExt).toLowerCase()) ?? [];
	if (cands.length === 0) return null;
	// Obsidian prefers the closest match; any match resolves.
	return cands.sort((a, b) => relative(dirname(sourceNote), a).length - relative(dirname(sourceNote), b).length)[0];
}

function checkLinks(md, notePathInVault, index) {
	const text = stripNonRendered(md);
	const links = [];
	for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
		const embed = m[1] === "!";
		const inner = m[2].split("|")[0];
		const hashAt = inner.indexOf("#");
		const file = hashAt === -1 ? inner : inner.slice(0, hashAt);
		const sub = hashAt === -1 ? null : inner.slice(hashAt + 1);
		const entry = { raw: m[0], embed, file: file.trim(), subpath: sub, resolved: null, ok: false, reason: null };
		const target = file.trim() ? resolveTarget(index, file.trim(), notePathInVault) : notePathInVault;
		if (!target || !existsSync(target)) {
			entry.reason = "file not found";
			links.push(entry);
			continue;
		}
		entry.resolved = relative(index.vault, target).split(sep).join("/");
		if (sub) {
			const targetMd = target === notePathInVault ? md : readFileSync(target, "utf8");
			if (sub.startsWith("^")) {
				entry.ok = new RegExp(`\\^${sub.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(targetMd);
				if (!entry.ok) entry.reason = "block id not found";
			} else {
				const wanted = normHeading(sub.split("#").pop());
				entry.ok = headingsOf(targetMd).some((h) => normHeading(h) === wanted);
				if (!entry.ok) entry.reason = "heading not found";
			}
		} else entry.ok = true;
		links.push(entry);
	}
	return links;
}

// ── Per-scenario analysis ───────────────────────────────────────────────────

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

async function analyzeScenario(outDir, id, mermaidLib) {
	const tracePath = join(outDir, `${id}.json`);
	const notePath = join(outDir, `${id}.md`);
	const trace = JSON.parse(readFileSync(tracePath, "utf8"));
	const scenario = trace.scenario ?? { id, kind: "unknown" };
	const res = { id, kind: scenario.kind, topic: scenario.topic, model: trace.model ?? trace.phases?.[0]?.model, notes: [] };
	if (trace.fatal) res.notes.push(`harness fatal: ${String(trace.fatal).split("\n")[0]}`);
	if (!existsSync(notePath)) {
		res.error = "no note copy (<scenario>.md) in run directory";
		res.criteria = [{ id: "note-exists", pass: false, detail: res.error }];
		res.pass = false;
		return res;
	}
	const md = readFileSync(notePath, "utf8");
	const phases = trace.phases?.length ? trace.phases : [trace];
	const calls = phases.flatMap((p) => p.toolCalls ?? []);
	const assistant = phases.flatMap((p) => (p.assistantMessages ?? []).map((m) => ({ ...m, phase: p.phase })));
	const planTexts = phases.flatMap((p) => (p.driver?.planMessageIds ?? []).map((i) => p.assistantMessages[i]?.text ?? ""));

	// Mermaid
	const extract = mermaidLib.lib?.extractMermaidBlocks ?? fallbackExtract;
	const describe = mermaidLib.lib?.describeMermaid ?? fallbackDescribe;
	const blocks = extract(md);
	const diagrams = [];
	for (const [i, b] of blocks.entries()) {
		const shape = describe(b.source);
		let validity = "skipped";
		let error;
		if (mermaidLib.lib?.validateMermaid) {
			const v = await mermaidLib.lib.validateMermaid(b.source);
			validity = v.status;
			error = v.error;
		}
		const inPlan = planTexts.some((t) => t.includes(b.source.trim().split("\n").slice(0, 3).join("\n")));
		const role = shape.tag?.kind === "dependency-map" ? "dependency-map" : shape.tag?.kind === "system" ? "concept" : inPlan ? "dependency-map" : "concept";
		diagrams.push({
			index: i + 1,
			role,
			tagged: !!shape.tag,
			tag: shape.tag,
			level: shape.tag?.level,
			diagramType: shape.diagramType,
			nodes: shape.nodes,
			edges: shape.edges,
			approximate: !!shape.approximate,
			validity,
			error,
			// Timelines have no drawn edges: consecutive events are the sequence (n events → n-1 steps).
			meetsSize: shape.nodes >= 3 && (/^timeline/i.test(shape.diagramType) ? shape.nodes - 1 : shape.edges) >= 2,
			preview: b.source.split("\n").slice(0, 2).join(" ⏎ ").slice(0, 120),
		});
	}
	const concept = diagrams.filter((d) => d.role === "concept");
	const depMaps = diagrams.filter((d) => d.role === "dependency-map");
	const hiddenDiagrams = (md.match(/^> \[!warning\] Diagram hidden/gm) || []).length;
	const rawAssistantMermaid = assistant.reduce((n, m) => n + (m.mermaidBlocks ?? 0), 0);

	// Callouts vs QA calls
	const callouts = parseCallouts(md);
	const questionCallouts = callouts.filter(isQuestionCallout);
	const answerCallouts = callouts.filter(isAnswerCallout);
	const qaCalls = calls.filter((c) => QA_TOOLS.has(c.name));
	const qaExecuted = qaCalls.filter((c) => c.executed);
	const qaBlocked = qaCalls.filter((c) => c.blocked);
	const leaks = [];
	for (const c of qaCalls.filter((c) => c.name === "quiz")) {
		const exp = norm(c.args?.explanation);
		if (exp.length < 12) continue;
		const probe = exp.length > 80 ? exp.slice(0, 80) : exp;
		for (const q of questionCallouts) if (norm(q.body).includes(probe)) leaks.push({ question: c.args?.question, calloutLine: q.line });
	}

	// Links
	const vault = trace.vault ?? null;
	const notePathInVault = trace.paths?.note ?? trace.phases?.at(-1)?.paths?.note ?? null;
	const noteRel = vault && notePathInVault ? relative(vault, notePathInVault) : null;
	const linksChecked = !!(vault && existsSync(vault) && notePathInVault && existsSync(notePathInVault) && noteRel !== ".." && !noteRel?.startsWith(`..${sep}`) && !isAbsolute(noteRel));
	let links = [];
	if (linksChecked) links = checkLinks(md, notePathInVault, indexVault(vault));
	else res.notes.push("vault/note path unavailable: link resolution pending");
	const unresolved = links.filter((l) => !l.ok);

	const startModes = phases.map((p) => p.driver?.startMode);
	const structure = checkStructure(md, { createdByLearn: startModes[0] === "learn-command" });
	const learner = phases.flatMap((p) => p.learnerDecisions ?? []);

	res.mermaid = {
		validator: mermaidLib.lib ? "extensions/lib/mermaid.ts" : `skipped (${mermaidLib.reason})`,
		blocksInNote: blocks.length,
		blocksInAssistantText: rawAssistantMermaid,
		hiddenInvalidDiagrams: hiddenDiagrams,
		dependencyMaps: depMaps.length,
		conceptDiagrams: concept.length,
		diagrams,
	};
	res.qa = {
		questionCallouts: questionCallouts.length,
		answerCallouts: answerCallouts.length,
		qaCalls: qaCalls.length,
		qaExecuted: qaExecuted.length,
		qaBlocked: qaBlocked.length,
		quizExecuted: qaExecuted.filter((c) => c.name === "quiz").length,
		askExecuted: qaExecuted.filter((c) => c.name === "ask_user_question").length,
		explanationLeaks: leaks,
		learner: {
			decisions: learner.length,
			correct: learner.filter((d) => d.observed === "correct").length,
			wrong: learner.filter((d) => d.observed === "wrong").length,
			dontKnow: learner.filter((d) => d.observed === "dontknow").length,
			inconsistent: learner.filter((d) => d.consistent === false).length,
			errors: learner.filter((d) => d.error).length,
		},
	};
	res.links = { total: links.length, unresolved: unresolved.length, details: links };
	res.structure = structure;
	res.driver = phases.map((p) => ({ phase: p.phase ?? "main", startMode: p.driver?.startMode, approved: p.driver?.approved, approvedVia: p.driver?.approvedVia, stopReason: p.driver?.stopReason, userTurns: p.userPrompts?.length }));
	if (trace.resume) res.resume = trace.resume;
	res.errors = phases.flatMap((p) => [...(p.errors ?? []), ...(p.extensionErrors ?? [])]).map((e) => e.message ?? e.error ?? JSON.stringify(e));

	// Acceptance criteria
	const kind = scenario.kind;
	const criteria = [];
	const add = (cid, pass, detail) => criteria.push({ id: cid, pass, detail });
	if (kind === "system" || kind === "resume") add("concept-diagrams", concept.length >= 1, `${concept.length} concept diagram(s), need ≥1`);
	else if (kind === "complex-system") {
		const overview = concept.some((d) => d.level === "overview");
		const zoom = concept.some((d) => d.level === "zoom");
		add("concept-diagrams", concept.length >= 2 && overview && zoom, `${concept.length} concept diagram(s), overview=${overview}, zoom=${zoom}; need ≥2 incl. overview + zoom`);
	} else if (kind === "ambiguous") add("concept-diagrams", concept.length >= 1, `${concept.length} concept diagram(s), need ≥1`);
	else if (kind === "non-system") add("no-concept-diagrams", concept.length === 0, `${concept.length} concept diagram(s), need 0`);
	const validatorReady = typeof mermaidLib.lib?.validateMermaid === "function";
	if (!validatorReady) add("mermaid-valid", null, `pending: validator unavailable (${mermaidLib.reason ?? "no validateMermaid function"})`);
	else {
		const bad = diagrams.filter((d) => d.validity !== "valid");
		add("mermaid-valid", bad.length === 0, bad.length ? `${bad.length} not valid: ${bad.map((d) => `#${d.index} ${d.validity}${d.error ? ` (${String(d.error).split("\n")[0].slice(0, 80)})` : ""}`).join("; ")}` : `${diagrams.length} block(s) valid`);
	}
	const small = concept.filter((d) => !d.meetsSize);
	add("diagram-size", small.length === 0, small.length ? `${small.length} concept diagram(s) below 3 nodes / 2 edges: ${small.map((d) => `#${d.index} (${d.nodes}n/${d.edges}e)`).join(", ")}` : "all concept diagrams ≥3 nodes, ≥2 edges");
	add("qa-callouts", questionCallouts.length === qaExecuted.length, `${questionCallouts.length} question callout(s) vs ${qaExecuted.length} executed QA call(s) (${qaBlocked.length} blocked); ${answerCallouts.length} answer callout(s)`);
	add("no-explanation-leak", leaks.length === 0, leaks.length ? `${leaks.length} question callout(s) contain the quiz explanation` : "no leaks");
	add("links-resolve", linksChecked ? unresolved.length === 0 : null, !linksChecked ? "pending: vault/note unavailable" : unresolved.length ? `${unresolved.length} unresolved: ${unresolved.map((l) => `${l.raw} (${l.reason})`).join(", ")}` : `${links.length} link(s), all resolve`);
	add("note-structure", structure.ok, structure.ok ? `frontmatter ok, ${structure.sections.length} session section(s)` : structure.problems.join("; "));
	if (kind === "resume") add("resume-continued", res.resume?.verdict === "continued", `verdict: ${res.resume?.verdict ?? "n/a"} ${JSON.stringify(res.resume?.signals ?? {})}`);
	const incomplete = [];
	if (trace.fatal) incomplete.push(`fatal: ${String(trace.fatal).split("\n")[0]}`);
	for (const p of phases) {
		if (!p.driver?.stopReason || ["error", "timeout"].includes(p.driver.stopReason)) incomplete.push(`${p.phase ?? "main"}: stopped ${p.driver?.stopReason ?? "without reason"}`);
		if ((p.resources?.extensionLoadErrors ?? []).length || (p.extensionErrors ?? []).length) incomplete.push(`${p.phase ?? "main"}: extension error`);
		if ((p.learnerDecisions ?? []).some((d) => d.consistent === false || d.error)) incomplete.push(`${p.phase ?? "main"}: learner mismatch`);
	}
	add("harness-complete", incomplete.length === 0, incomplete.length ? incomplete.join("; ") : `${phases.length} phase(s) completed without fatal, timeout, extension or learner errors`);
	res.criteria = criteria;
	res.pass = criteria.every((c) => c.pass === true);
	return res;
}

function renderMarkdown(report) {
	const L = [];
	L.push(`# pi-learn e2e report — ${report.runId}`, "");
	L.push(`Generated ${report.generatedAt}. Mermaid validator: ${report.validator}.`, "");
	L.push(`**${report.summary.passed}/${report.summary.total} scenario(s) pass.**`, "");
	const ids = [...new Set(report.scenarios.flatMap((s) => (s.criteria ?? []).map((c) => c.id)))];
	L.push(`| Scenario | Kind | Pass | ${ids.join(" | ")} |`);
	L.push(`| --- | --- | --- | ${ids.map(() => "---").join(" | ")} |`);
	const cell = (c) => (c === undefined ? "" : c.pass === null ? "skip" : c.pass ? "✅" : "❌");
	for (const s of report.scenarios) L.push(`| ${s.id} | ${s.kind} | ${s.pass ? "✅" : "❌"} | ${ids.map((i) => cell(s.criteria?.find((c) => c.id === i))).join(" | ")} |`);
	L.push("");
	for (const s of report.scenarios) {
		L.push(`## ${s.id} — ${s.topic ?? ""}`, "");
		if (s.error) {
			L.push(`Error: ${s.error}`, "");
			continue;
		}
		L.push(`Model: ${s.model ?? "?"}. Driver: ${s.driver.map((d) => `${d.phase}: ${d.startMode}, ${d.userTurns} turn(s), approved=${d.approved}${d.approvedVia ? ` (${d.approvedVia})` : ""}, stop=${d.stopReason}`).join(" / ")}`, "");
		for (const c of s.criteria) L.push(`- ${c.pass === null ? "⏭" : c.pass ? "✅" : "❌"} **${c.id}** — ${c.detail}`);
		L.push("");
		L.push(`Mermaid: ${s.mermaid.blocksInNote} block(s) in note (${s.mermaid.dependencyMaps} dependency map, ${s.mermaid.conceptDiagrams} concept; ${s.mermaid.hiddenInvalidDiagrams} hidden as invalid; ${s.mermaid.blocksInAssistantText} in raw assistant text).`);
		for (const d of s.mermaid.diagrams) L.push(`  - #${d.index} ${d.role}${d.tagged ? ` [${d.tag.kind}${d.level ? `/${d.level}` : ""}${d.tag.label ? `: ${d.tag.label}` : ""}]` : " [untagged]"} ${d.diagramType} ${d.nodes}n/${d.edges}e${d.approximate ? " (approx)" : ""} — ${d.validity}`);
		L.push(`QA: ${s.qa.questionCallouts} question / ${s.qa.answerCallouts} answer callout(s); ${s.qa.qaExecuted} executed (${s.qa.quizExecuted} quiz, ${s.qa.askExecuted} ask), ${s.qa.qaBlocked} blocked. Learner: ${s.qa.learner.correct} correct, ${s.qa.learner.wrong} wrong, ${s.qa.learner.dontKnow} don't-know, ${s.qa.learner.inconsistent} inconsistent, ${s.qa.learner.errors} driver error(s).`);
		L.push(`Links: ${s.links.total} total, ${s.links.unresolved} unresolved.`);
		if (s.resume) L.push(`Resume: ${s.resume.verdict} ${JSON.stringify(s.resume.signals ?? {})}`);
		if (s.errors?.length) L.push(`Errors: ${s.errors.map((e) => String(e).split("\n")[0].slice(0, 160)).join(" | ")}`);
		if (s.notes?.length) L.push(`Notes: ${s.notes.join("; ")}`);
		L.push("");
	}
	return L.join("\n");
}

export async function analyzeOutDir(outDir) {
	outDir = resolve(outDir);
	const ids = readdirSync(outDir)
		.filter((f) => f.endsWith(".json") && !f.startsWith("report") && !f.includes(".tmp."))
		.map((f) => f.slice(0, -5))
		.sort();
	const mermaidLib = await loadMermaidLib();
	const scenarios = [];
	for (const id of ids) {
		try {
			scenarios.push(await analyzeScenario(outDir, id, mermaidLib));
		} catch (err) {
			scenarios.push({ id, error: `analysis failed: ${err.message}`, criteria: [], pass: false });
		}
	}
	const report = {
		runId: basename(outDir),
		generatedAt: new Date().toISOString(),
		validator: mermaidLib.lib ? "extensions/lib/mermaid.ts" : `skipped (${mermaidLib.reason})`,
		summary: { total: scenarios.length, passed: scenarios.filter((s) => s.pass).length },
		scenarios,
	};
	writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
	writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
	return report;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const dir = process.argv[2];
	if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
		console.error("usage: node tests/e2e/analyze.mjs <outDir>");
		process.exit(2);
	}
	const report = await analyzeOutDir(dir);
	for (const s of report.scenarios) {
		console.log(`${s.pass ? "PASS" : "FAIL"} ${s.id}`);
		for (const c of s.criteria ?? []) console.log(`   ${c.pass === null ? "skip" : c.pass ? " ok " : "FAIL"} ${c.id}: ${c.detail}`);
		if (s.error) console.log(`   error: ${s.error}`);
	}
	console.log(`\n${report.summary.passed}/${report.summary.total} pass -> ${join(resolve(dir), "report.md")}`);
	process.exit(report.summary.total > 0 && report.summary.passed === report.summary.total ? 0 : 1); // the Mermaid validator's worker thread would otherwise keep the process alive
}
