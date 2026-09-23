// Unit tests for extensions/lib/learn-notes.ts (pure helpers, loaded with Node's native type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	HIDDEN_DIAGRAM_CALLOUT,
	INDEX_BASENAME,
	buildIndexNote,
	buildResumeBrief,
	continuesLine,
	extractQuizHistory,
	extractSystemTags,
	findMermaidFences,
	findSessionSections,
	formatDate,
	formatDateTime,
	hideMermaidBlocks,
	pickDependencyMap,
	pickMostRecent,
	readFrontmatter,
	sanitizeNoteName,
	sessionListEntry,
	splitFrontmatter,
	summarizeNote,
	transcriptTail,
	updateFrontmatter,
	upsertSessionSection,
} from "../../extensions/lib/learn-notes.ts";

const SID = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";
const SID2 = "9a8b7c6d-aaaa-bbbb-cccc-000000000002";

// ─── dates ───────────────────────────────────────────────────────────────────

test("date formats are local and zero-padded", () => {
	const d = new Date(2026, 0, 5, 7, 3);
	assert.equal(formatDate(d), "2026-01-05");
	assert.equal(formatDateTime(d), "2026-01-05T07:03");
	assert.equal(sessionListEntry(d, SID), "2026-01-05 07:03 · 0f1e2d3c");
});

// ─── filenames ───────────────────────────────────────────────────────────────

test("sanitizeNoteName strips Obsidian-unsafe characters, collapses spaces, caps length", () => {
	assert.equal(sanitizeNoteName('How does  TCP/IP work? [part #1] "intro" ^x | a<b>c*d:e\\f'), "How does TCP IP work part 1 intro x a b c d e f");
	assert.equal(sanitizeNoteName("  ...hidden. "), "hidden");
	assert.equal(sanitizeNoteName("?:*"), "");
	const long = sanitizeNoteName("word ".repeat(40));
	assert.ok(long.length <= 80, `length ${long.length}`);
	assert.ok(!long.endsWith(" "));
});

// ─── frontmatter ─────────────────────────────────────────────────────────────

const FULL_UPDATE = {
	topic: "Binary search",
	status: "active",
	created: "2026-09-23",
	updated: "2026-09-23T14:05",
	session: "2026-09-23 14:05 · 0f1e2d3c",
	tags: ["learn"],
	cssclasses: ["pi-learn"],
};

test("frontmatter is created for a note without one; the body stays byte-for-byte", () => {
	const body = "# My notes\n\nSome text I wrote.\n";
	const out = updateFrontmatter(body, FULL_UPDATE);
	assert.equal(
		out,
		[
			"---",
			'learn-topic: "Binary search"',
			"learn-status: active",
			"learn-created: 2026-09-23",
			"learn-updated: 2026-09-23T14:05",
			"learn-sessions:",
			'  - "2026-09-23 14:05 · 0f1e2d3c"',
			"tags:",
			"  - learn",
			"cssclasses:",
			"  - pi-learn",
			"---",
			"",
		].join("\n") + body,
	);
	const fm = readFrontmatter(out);
	assert.equal(fm["learn-topic"], "Binary search");
	assert.deepEqual(fm["learn-sessions"], ["2026-09-23 14:05 · 0f1e2d3c"]);
	assert.deepEqual(fm.tags, ["learn"]);
	assert.equal(splitFrontmatter(out).body, body);
});

test("frontmatter merge keeps unknown keys, their order and bytes; only-if-absent keys are not overwritten", () => {
	const before = [
		"---",
		"aliases:",
		"  - BST",
		"learn-topic: 'My own topic'",
		"rating: 5 # comment",
		"learn-status: paused",
		"learn-updated: 2020-01-01T00:00",
		"tags: [cs, algorithms]",
		"---",
		"body",
	].join("\n");
	const out = updateFrontmatter(before, FULL_UPDATE);
	const lines = splitFrontmatter(out).lines;
	assert.deepEqual(lines.slice(0, 7), [
		"aliases:",
		"  - BST",
		"learn-topic: 'My own topic'",
		"rating: 5 # comment",
		"learn-status: paused",
		"learn-updated: 2026-09-23T14:05",
		"tags: [cs, algorithms]",
	]);
	const fm = readFrontmatter(out);
	assert.equal(fm["learn-topic"], "My own topic");
	assert.equal(fm["learn-status"], "paused");
	assert.equal(fm["learn-created"], "2026-09-23");
	assert.deepEqual(fm.tags, ["cs", "algorithms"], "tags only added when absent");
	assert.deepEqual(fm.cssclasses, ["pi-learn"]);
	assert.ok(out.endsWith("---\nbody"));
});

test("learn-sessions appends new items and never duplicates a session id", () => {
	let text = updateFrontmatter("", { session: "2026-09-20 10:00 · 0f1e2d3c" });
	text = updateFrontmatter(text, { session: "2026-09-23 14:05 · 9a8b7c6d" });
	text = updateFrontmatter(text, { session: "2026-09-23 14:09 · 9a8b7c6d" });
	assert.deepEqual(readFrontmatter(text)["learn-sessions"], ["2026-09-20 10:00 · 0f1e2d3c", "2026-09-23 14:05 · 9a8b7c6d"]);
	// inline list form is converted to a block list, keeping its items
	const inline = updateFrontmatter('---\nlearn-sessions: ["2026-09-20 10:00 · 0f1e2d3c"]\n---\n', {
		session: "2026-09-23 14:05 · 9a8b7c6d",
	});
	assert.deepEqual(readFrontmatter(inline)["learn-sessions"], ["2026-09-20 10:00 · 0f1e2d3c", "2026-09-23 14:05 · 9a8b7c6d"]);
});

test("cssclasses: pi-learn is merged into existing values without dropping or duplicating", () => {
	const cases = [
		["---\ncssclasses:\n  - wide\n---\n", ["wide", "pi-learn"], "cssclasses:\n  - wide\n  - pi-learn\n"],
		["---\ncssclasses: [wide, cards]\n---\n", ["wide", "cards", "pi-learn"], null],
		["---\ncssclasses: wide\n---\n", ["wide", "pi-learn"], null],
		["---\ncssclasses:\n---\n", ["pi-learn"], null],
		["---\ncssclasses:\n- wide\n- pi-learn\n---\n", ["wide", "pi-learn"], "cssclasses:\n- wide\n- pi-learn\n"],
		["---\ntitle: x\n---\n", ["pi-learn"], "cssclasses:\n  - pi-learn\n"],
	];
	for (const [input, expected, snippet] of cases) {
		const out = updateFrontmatter(input, { cssclasses: ["pi-learn"] });
		assert.deepEqual(readFrontmatter(out).cssclasses, expected, input);
		if (snippet) assert.ok(out.includes(snippet), `${JSON.stringify(out)} lacks ${JSON.stringify(snippet)}`);
		assert.equal(updateFrontmatter(out, { cssclasses: ["pi-learn"] }), out, "idempotent");
	}
});

test("CRLF frontmatter stays CRLF and unchanged lines stay byte-identical", () => {
	const before = "---\r\ntitle: x\r\n---\r\nbody\r\n";
	const out = updateFrontmatter(before, { updated: "2026-09-23T14:05" });
	assert.equal(out, "---\r\ntitle: x\r\nlearn-updated: 2026-09-23T14:05\r\n---\r\nbody\r\n");
});

// ─── sessions ────────────────────────────────────────────────────────────────

test("a new session section is appended with heading + marker; N counts markers", () => {
	const r1 = upsertSessionSection("", { sessionId: SID, date: "2026-09-20", content: "> [!quote] YOU\n\nhi" });
	assert.equal(r1.created, true);
	assert.equal(r1.text, `## Session 1 (2026-09-20)\n%% learn-session: ${SID} %%\n\n> [!quote] YOU\n\nhi\n`);
	const r2 = upsertSessionSection(r1.text, { sessionId: SID2, date: "2026-09-23", content: "" });
	assert.equal(r2.heading, "Session 2 (2026-09-23)");
	assert.equal(r2.text, `${r1.text}\n## Session 2 (2026-09-23)\n%% learn-session: ${SID2} %%\n`);
	assert.ok(r2.text.startsWith(r1.text), "earlier content is a byte-for-byte prefix");
});

test("re-linking the same session regenerates only its section (idempotent)", () => {
	const fm = "---\nlearn-topic: \"x\"\n---\n";
	const s1 = `## Session 1 (2026-09-20)\n%% learn-session: ${SID} %%\n\nold one\n\nMY OWN NOTE between sessions\n`;
	const s2 = `\n## Session 2 (2026-09-21)\n%% learn-session: ${SID2} %%\n${continuesLine("Session 1 (2026-09-20)")}\n\nold two\n`;
	const note = fm + s1 + s2;
	const r = upsertSessionSection(note, { sessionId: SID, date: "2026-09-23", content: "new one" });
	assert.equal(r.created, false);
	assert.equal(r.heading, "Session 1 (2026-09-20)", "heading (and its date) are kept");
	assert.equal(r.text, `${fm}## Session 1 (2026-09-20)\n%% learn-session: ${SID} %%\n\nnew one\n${s2}`);
	const again = upsertSessionSection(r.text, { sessionId: SID, date: "2026-09-23", content: "new one" });
	assert.equal(again.text, r.text);
	// the last section keeps its Continues line on re-link
	const r2 = upsertSessionSection(note, { sessionId: SID2, date: "2026-09-23", content: "new two" });
	assert.ok(r2.text.endsWith(`%% learn-session: ${SID2} %%\nContinues [[#Session 1 (2026-09-20)]].\n\nnew two\n`));
	assert.ok(r2.text.startsWith(fm + s1));
});

test("a legacy note without markers keeps its content; the new section is appended after it", () => {
	const legacy = "> [!quote] YOU\n\nold question\n\n> [!abstract] PI\n\nold answer"; // no trailing newline
	const r = upsertSessionSection(legacy, { sessionId: SID, date: "2026-09-23", content: "x" });
	assert.equal(r.heading, "Session 1 (2026-09-23)");
	assert.ok(r.text.startsWith(legacy));
	assert.equal(r.text.slice(legacy.length), `\n\n## Session 1 (2026-09-23)\n%% learn-session: ${SID} %%\n\nx\n`);
});

test("resumed section: Continues link text equals the previous heading exactly", () => {
	const base = upsertSessionSection("", { sessionId: SID, date: "2026-09-20", content: "a" }).text;
	const r = upsertSessionSection(base, { sessionId: SID2, date: "2026-09-23", content: "", continuesPrevious: true });
	const sections = findSessionSections(r.text);
	assert.equal(sections.length, 2);
	assert.equal(sections[1].continues, `Continues [[#${sections[0].heading}]].`);
	assert.equal(r.previousHeading, sections[0].heading);
	const lines = r.text.split("\n");
	const markerAt = lines.indexOf(`%% learn-session: ${SID2} %%`);
	assert.equal(lines[markerAt + 1], "Continues [[#Session 1 (2026-09-20)]].");
	// no previous section → no Continues line
	const first = upsertSessionSection("", { sessionId: SID, date: "2026-09-20", content: "", continuesPrevious: true });
	assert.ok(!first.text.includes("Continues"));
});

// ─── index ───────────────────────────────────────────────────────────────────

test("index table: wikilinks, newest first, excludes itself and non-learning notes", () => {
	const note = (topic, updated, sessions) =>
		`---\nlearn-topic: "${topic}"\nlearn-status: active\nlearn-updated: ${updated}\nlearn-sessions:\n${sessions
			.map((s) => `  - "${s}"`)
			.join("\n")}\n---\nbody\n`;
	const a = summarizeNote(note("Alpha | pipes", "2026-09-20T10:00", ["2026-09-20 10:00 · aaaaaaaa"]), "Alpha", 0);
	const b = summarizeNote(note("Beta", "2026-09-23T09:30", ["x · 1", "y · 2"]), "Beta", 0);
	const c = summarizeNote("---\nlearn-topic: \"Gamma\"\n---\n", "Gamma", new Date(2026, 8, 21, 8, 0).getTime());
	assert.equal(summarizeNote("no frontmatter", "Plain", 0), null);
	assert.equal(summarizeNote(note("Idx", "2026-09-23T09:30", []), INDEX_BASENAME, 0), null);
	const index = buildIndexNote([a, c, b]);
	const rows = index.split("\n").filter((l) => l.startsWith("| [["));
	assert.deepEqual(rows, [
		"| [[Beta]] | Beta | active | 2 | 2026-09-23 09:30 |",
		"| [[Gamma]] | Gamma |  | 0 | 2026-09-21 08:00 |",
		"| [[Alpha]] | Alpha \\| pipes | active | 1 | 2026-09-20 10:00 |",
	]);
	assert.ok(index.includes("| Note | Topic | Status | Sessions | Last studied |"));
	assert.ok(!index.includes(`[[${INDEX_BASENAME}]]`));
	assert.equal(pickMostRecent([a, b, c]).basename, "Beta");
	assert.equal(pickMostRecent([]), null);
});

// ─── mermaid ─────────────────────────────────────────────────────────────────

test("invalid mermaid blocks are replaced by the warning + the source hidden in %% comments", () => {
	const good = "```mermaid\nflowchart LR\n  A --> B\n```";
	const bad = "```mermaid\nflowchart LR\n  A -->\n```";
	const text = `Intro\n\n${good}\n\nMiddle\n\n${bad}\n\nEnd`;
	const fences = findMermaidFences(text);
	assert.equal(fences.length, 2);
	assert.equal(fences[1].source, "flowchart LR\n  A -->");
	const out = hideMermaidBlocks(text, [fences[1]]);
	assert.equal(out, `Intro\n\n${good}\n\nMiddle\n\n${HIDDEN_DIAGRAM_CALLOUT}\n\n%%\n${bad}\n%%\n\nEnd`);
	const after = findMermaidFences(out);
	assert.equal(after.length, 2);
	assert.equal(after[0].hidden, false);
	assert.equal(after[1].hidden, true, "hidden block is recognised as commented out");
	assert.equal(hideMermaidBlocks(text, []), text);
});

test("mermaid inside another fence is not a block; unclosed fences are ignored", () => {
	const text = "````markdown\n```mermaid\nflowchart LR\n```\n````\n\n```mermaid\ngraph TD\n";
	assert.deepEqual(findMermaidFences(text), []);
});

// ─── resume brief ────────────────────────────────────────────────────────────

const NOTE = `---
learn-topic: "How CPUs work"
learn-sessions:
  - "2026-09-20 10:00 · 0f1e2d3c"
---
## Session 1 (2026-09-20)
%% learn-session: ${SID} %%

> [!abstract] PI

Here is the plan.

\`\`\`mermaid
flowchart TD
%% dependency-map
  A[Bits] --> B[Gates]
\`\`\`

> [!question] Quiz
> What does a NAND gate output for inputs 1,1?
>
> 1. 0
> 2. 1

> [!success] Quiz — correct ✓
> Your answer: 1. 0
> Correct answer: 1

> [!question] Quiz
> Which unit decodes instructions?
>
> 1. ALU
> 2. Control unit

> [!failure] Quiz — incorrect ✗
> Your answer: 1. ALU
> Correct answer: 2

> [!abstract] PI

\`\`\`mermaid
flowchart LR
%% system: Fetch-decode-execute cycle — overview
  F --> D --> E --> F
\`\`\`

## Session 2 (2026-09-21)
%% learn-session: ${SID2} %%
Continues [[#Session 1 (2026-09-20)]].

\`\`\`mermaid
flowchart TD
%% dependency-map
  A[Bits] --> B[Gates] --> C[ALU]
\`\`\`

\`\`\`mermaid
flowchart LR
%% system: ALU — zoom: adder
  X --> Y
\`\`\`

> [!question] Quiz
> Is a half adder built from XOR and AND?
>
> 1. Yes
> 2. No

> [!question] Quiz — I don't know
> Your answer: I don't know
> Correct answer: 1

> [!question] Quiz
> Pending question?
>
> 1. a
> 2. b

> [!warning] Quiz — cancelled
> (user skipped)

> [!question] Quiz
> Never answered?
>
> 1. a
> 2. b
`;

test("resume brief pieces: dependency map, system tags, quiz verdicts", () => {
	assert.equal(pickDependencyMap(NOTE), "flowchart TD\n%% dependency-map\n  A[Bits] --> B[Gates] --> C[ALU]");
	assert.equal(pickDependencyMap("```mermaid\ngraph LR\n  x --> y\n```\n\n```mermaid\ngraph TD\n```"), "graph LR\n  x --> y");
	assert.equal(pickDependencyMap("no diagrams"), null);
	assert.deepEqual(extractSystemTags(NOTE), ["Fetch-decode-execute cycle — overview", "ALU — zoom: adder"]);
	assert.deepEqual(
		extractQuizHistory(NOTE).map((q) => [q.question, q.verdict]),
		[
			["What does a NAND gate output for inputs 1,1?", "correct"],
			["Which unit decodes instructions?", "incorrect"],
			["Is a half adder built from XOR and AND?", "I don't know"],
			["Pending question?", "cancelled"],
			["Never answered?", "unanswered"],
		],
	);
});

test("hidden (invalid) diagrams are not offered as dependency map or system tags", () => {
	const text = `${HIDDEN_DIAGRAM_CALLOUT}\n\n%%\n\`\`\`mermaid\nflowchart TD\n%% dependency-map\n%% system: Broken — overview\nA -->\n\`\`\`\n%%\n`;
	assert.equal(pickDependencyMap(text), null);
	assert.deepEqual(extractSystemTags(text), []);
});

test("transcript tail is cut at a block boundary", () => {
	const blocks = [];
	for (let i = 0; i < 400; i++) blocks.push(`> [!abstract] PI\n\nparagraph number ${i} with some filler text`);
	const body = blocks.join("\n\n");
	const tail = transcriptTail(body, 2000);
	assert.equal(tail.truncated, true);
	assert.ok(tail.text.length <= 2000, `tail length ${tail.text.length}`);
	assert.ok(tail.text.startsWith("> [!abstract] PI\n\nparagraph number"), tail.text.slice(0, 40));
	assert.ok(tail.text.endsWith("paragraph number 399 with some filler text"));
	assert.deepEqual(transcriptTail("short\n", 2000), { text: "short", truncated: false });
});

test("buildResumeBrief is deterministic and contains every section + instructions", () => {
	const brief = buildResumeBrief(NOTE, { noteName: "How CPUs work", newHeading: "Session 3 (2026-09-23)" });
	assert.equal(brief, buildResumeBrief(NOTE, { noteName: "How CPUs work", newHeading: "Session 3 (2026-09-23)" }));
	for (const needle of [
		"Topic: How CPUs work",
		"- Session 1 (2026-09-20)",
		"- Session 2 (2026-09-21)",
		"Session 3 (2026-09-23)",
		"A[Bits] --> B[Gates] --> C[ALU]",
		"- Fetch-decode-execute cycle — overview",
		"- ALU — zoom: adder",
		"1. [correct] What does a NAND gate output for inputs 1,1?",
		"3. [I don't know] Is a half adder built from XOR and AND?",
		"<note-tail>",
		"Do not restart the probe from scratch",
		"re-establish where we stopped (2–3 sentences)",
		"name the next node of the dependency map",
		"re-check it with one quiz",
		"motivate → establish → connect → quiz-check",
		"Mermaid diagrams for systems",
	]) {
		assert.ok(brief.includes(needle), `brief lacks: ${needle}`);
	}
	assert.ok(!brief.includes("learn-topic:"), "frontmatter is not part of the tail");
	// topic falls back to the note name
	assert.ok(buildResumeBrief("plain note", { noteName: "Plain" }).includes("Topic: Plain"));
});
