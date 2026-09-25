/**
 * learn-notes — pure helpers for pi-learn's Obsidian notes (no pi imports, no I/O).
 *
 * Everything here is string-in / string-out so it can be unit-tested with
 * `node --test` and loaded by pi's jiti runtime alike. obsidian-link.ts owns the I/O.
 *
 * Note layout (see docs/CONTRACTS.md §2):
 *
 *   ---
 *   learn-topic: "Binary search"
 *   learn-status: active
 *   learn-created: 2026-09-23
 *   learn-updated: 2026-09-23T14:05
 *   learn-sessions:
 *     - "2026-09-23 14:05 · 1a2b3c4d"
 *   tags:
 *     - learn
 *   ---
 *   ## Session 1 (2026-09-23)
 *   %% learn-session: 1a2b3c4d-... %%
 *
 *   > [!quote] YOU
 *   ...
 */

export const INDEX_BASENAME = "Learn Index";
export const INDEX_FILENAME = `${INDEX_BASENAME}.md`;

/** Legacy warning text found in older notes; new notes hide drafts silently. */
export const HIDDEN_DIAGRAM_CALLOUT =
	"> [!warning] Diagram hidden — it needs a redraw (the tutor was asked to correct it)";

// ─── Dates (local time) ──────────────────────────────────────────────────────

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD` in local time. */
export function formatDate(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DDTHH:mm` in local time (Obsidian's date-time property format). */
export function formatDateTime(d: Date): string {
	return `${formatDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `"YYYY-MM-DD HH:mm · <first 8 chars of the session id>"` (without quotes). */
export function sessionListEntry(d: Date, sessionId: string): string {
	return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${sessionId.slice(0, 8)}`;
}

// ─── File names ──────────────────────────────────────────────────────────────

/**
 * Obsidian-safe note name for a topic: strips `\ / : * ? " < > | # ^ [ ]`,
 * collapses whitespace, trims dots/spaces at the ends, caps the length.
 */
export function sanitizeNoteName(topic: string, maxLength = 80): string {
	let name = topic
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (name.length > maxLength) name = name.slice(0, maxLength).trim();
	// Windows rejects trailing dots/spaces; a leading dot hides the file.
	name = name.replace(/^[.\s]+|[.\s]+$/g, "");
	return name;
}

// ─── Frontmatter (line based) ────────────────────────────────────────────────

export interface FrontmatterSplit {
	/** true when the text starts with a closed `---` block. */
	has: boolean;
	/** Raw lines between the delimiters (a trailing `\r` is kept, so unchanged lines stay byte-identical). */
	lines: string[];
	/** Everything after the closing delimiter line, byte-for-byte. */
	body: string;
	/** Offset in the original text where `body` starts. */
	bodyStart: number;
	/** `"\r"` when the frontmatter uses CRLF line ends, else `""`. */
	cr: string;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
	const none: FrontmatterSplit = { has: false, lines: [], body: text, bodyStart: 0, cr: "" };
	const first = /^---(\r?)\n/.exec(text);
	if (!first) return none;
	const cr = first[1];
	let pos = first[0].length;
	const lines: string[] = [];
	while (pos <= text.length) {
		const nl = text.indexOf("\n", pos);
		const raw = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
		const trimmed = raw.replace(/\r$/, "");
		if (trimmed === "---") {
			const bodyStart = nl === -1 ? text.length : nl + 1;
			return { has: true, lines, body: text.slice(bodyStart), bodyStart, cr };
		}
		if (nl === -1) break;
		lines.push(raw);
		pos = nl + 1;
	}
	return none; // unclosed: not frontmatter
}

interface FmBlock {
	key: string | null; // null: comment/preamble lines
	lines: string[];
}

const KEY_LINE = /^([A-Za-z0-9_][^:#]*?)\s*:(?:\s|$)(.*)$/;

function parseBlocks(lines: string[]): FmBlock[] {
	const blocks: FmBlock[] = [];
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		const m = /^\s/.test(line) || line.startsWith("-") ? null : KEY_LINE.exec(line);
		if (m) {
			blocks.push({ key: m[1], lines: [raw] });
		} else if (blocks.length > 0) {
			blocks[blocks.length - 1].lines.push(raw);
		} else {
			blocks.push({ key: null, lines: [raw] });
		}
	}
	return blocks;
}

function unquote(value: string): string {
	const v = value.trim();
	if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
		try {
			return JSON.parse(v);
		} catch {
			return v.slice(1, -1);
		}
	}
	if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
	return v;
}

function blockValue(block: FmBlock): string | string[] {
	const first = block.lines[0].replace(/\r$/, "");
	const m = KEY_LINE.exec(first);
	const inline = (m?.[2] ?? "").trim();
	if (inline.startsWith("[") && inline.endsWith("]")) {
		const inner = inline.slice(1, -1).trim();
		return inner ? splitInlineList(inner).map(unquote) : [];
	}
	if (inline) return unquote(inline);
	const items: string[] = [];
	for (const raw of block.lines.slice(1)) {
		const lm = /^\s*-\s?(.*)$/.exec(raw.replace(/\r$/, ""));
		if (lm) items.push(unquote(lm[1]));
	}
	return block.lines.length > 1 ? items : "";
}

function splitInlineList(inner: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (const ch of inner) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === ",") {
			out.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** Top-level frontmatter properties (strings or string lists), or null when there is none. */
export function readFrontmatter(text: string): Record<string, string | string[]> | null {
	const split = splitFrontmatter(text);
	if (!split.has) return null;
	const out: Record<string, string | string[]> = {};
	for (const block of parseBlocks(split.lines)) {
		if (block.key !== null) out[block.key] = blockValue(block);
	}
	return out;
}

/** A YAML double-quoted scalar (JSON strings are valid YAML). */
export function yamlString(s: string): string {
	return JSON.stringify(s);
}

export interface LearnFrontmatterUpdate {
	/** `learn-topic`, set only when absent. */
	topic?: string;
	/** `learn-status`, set only when absent. */
	status?: string;
	/** `learn-created` (YYYY-MM-DD), set only when absent. */
	created?: string;
	/** `learn-updated` (YYYY-MM-DDTHH:mm), always set. */
	updated?: string;
	/** Appended to `learn-sessions` unless an item for the same 8-char session id is there already. */
	session?: string;
	/** `tags` list, set only when the note has no `tags` property at all. */
	tags?: string[];
	/** Classes merged into `cssclasses` (existing values kept, no duplicates). */
	cssclasses?: string[];
}

/**
 * Update pi-learn's own frontmatter keys. Every other property keeps its lines
 * and position; the body after the frontmatter is untouched. A note without
 * frontmatter gets one prepended.
 */
export function updateFrontmatter(text: string, update: LearnFrontmatterUpdate): string {
	const split = splitFrontmatter(text);
	const cr = split.has ? split.cr : "";
	const blocks = parseBlocks(split.lines);
	const find = (key: string) => blocks.find((b) => b.key === key);
	const line = (s: string) => s + cr;

	const setIfAbsent = (key: string, value: string | undefined) => {
		if (value === undefined || find(key)) return;
		blocks.push({ key, lines: [line(`${key}: ${value}`)] });
	};
	const set = (key: string, value: string | undefined) => {
		if (value === undefined) return;
		const existing = find(key);
		if (existing) existing.lines = [line(`${key}: ${value}`)];
		else blocks.push({ key, lines: [line(`${key}: ${value}`)] });
	};

	setIfAbsent("learn-topic", update.topic === undefined ? undefined : yamlString(update.topic));
	setIfAbsent("learn-status", update.status);
	setIfAbsent("learn-created", update.created);
	set("learn-updated", update.updated);

	// Append `item` to the list property `key` unless `isDup` matches an existing item.
	// A block list gets one new line (existing lines untouched); an inline/scalar/empty
	// value is rewritten as a block list keeping its items.
	const appendToList = (key: string, rendered: string, isDup: (existing: string) => boolean) => {
		const existing = find(key);
		if (!existing) {
			blocks.push({ key, lines: [line(`${key}:`), line(`  - ${rendered}`)] });
			return;
		}
		const current = blockValue(existing);
		const items = Array.isArray(current) ? current : current ? [current] : [];
		if (items.some(isDup)) return;
		const firstLine = existing.lines[0].replace(/\r$/, "");
		const inlineEmpty = /:\s*$/.test(firstLine);
		if (inlineEmpty && Array.isArray(current)) {
			const itemLine = existing.lines.slice(1).find((l) => /^\s*-/.test(l));
			const indent = itemLine ? /^(\s*)-/.exec(itemLine)![1] : "  ";
			// insert after the last list item (keeps any trailing comment lines after it)
			let at = existing.lines.length;
			for (let k = existing.lines.length - 1; k >= 1; k--) {
				if (/^\s*-/.test(existing.lines[k])) {
					at = k + 1;
					break;
				}
			}
			existing.lines.splice(at, 0, line(`${indent}- ${rendered}`));
		} else {
			const quote = (s: string) => (/^[A-Za-z0-9_.\/-]+$/.test(s) ? s : yamlString(s));
			existing.lines = [line(`${key}:`), ...items.map((i) => line(`  - ${quote(i)}`)), line(`  - ${rendered}`)];
		}
	};

	if (update.session !== undefined) {
		const item = update.session;
		const id8 = item.slice(item.lastIndexOf("·") + 1).trim();
		appendToList("learn-sessions", yamlString(item), (i) => id8.length > 0 && i.trim().endsWith(`· ${id8}`));
	}

	if (update.tags && update.tags.length > 0 && !find("tags")) {
		blocks.push({ key: "tags", lines: [line("tags:"), ...update.tags.map((t) => line(`  - ${t}`))] });
	}

	for (const cls of update.cssclasses ?? []) {
		appendToList("cssclasses", cls, (i) => i.trim() === cls);
	}

	const nl = `${cr}\n`;
	const inner = blocks.flatMap((b) => b.lines);
	const head = `---${nl}${inner.map((l) => `${l}\n`).join("")}---${nl}`;
	return head + split.body;
}

// ─── Session sections ────────────────────────────────────────────────────────

export interface SessionSection {
	/** Heading text without `## `, e.g. `Session 2 (2026-09-23)`. */
	heading: string;
	n: number;
	date: string;
	/** Session id from the marker line, or null when the heading has no marker. */
	sessionId: string | null;
	/** `Continues [[#…]].` line directly under the marker, if any. */
	continues: string | null;
	/** Offset of the heading line. */
	start: number;
	/** Offset of the next session heading, or the text length. */
	end: number;
}

const SESSION_HEADING = /^## (Session (\d+) \((\d{4}-\d{2}-\d{2})\))[ \t]*\r?$/gm;
const SESSION_MARKER = /^%% learn-session: (\S+) %%[ \t]*\r?$/gm;
const CONTINUES_LINE = /^Continues \[\[#[^\]]*\]\]\.[ \t]*$/;

export function sessionMarker(sessionId: string): string {
	return `%% learn-session: ${sessionId} %%`;
}

export function sessionHeading(n: number, date: string): string {
	return `Session ${n} (${date})`;
}

export function continuesLine(previousHeading: string): string {
	return `Continues [[#${previousHeading}]].`;
}

/** Number of `%% learn-session: … %%` markers in the note body. */
export function countSessionMarkers(text: string): number {
	const { body } = splitFrontmatter(text);
	return [...body.matchAll(SESSION_MARKER)].length;
}

/** Session sections of the note body, in document order (offsets are into `text`). */
export function findSessionSections(text: string): SessionSection[] {
	const { body, bodyStart } = splitFrontmatter(text);
	const heads = [...body.matchAll(SESSION_HEADING)];
	const sections: SessionSection[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i];
		const start = bodyStart + h.index!;
		const end = i + 1 < heads.length ? bodyStart + heads[i + 1].index! : text.length;
		const lines = text.slice(start, end).split("\n").map((l) => l.replace(/\r$/, ""));
		const markerMatch = lines.length > 1 ? /^%% learn-session: (\S+) %%[ \t]*$/.exec(lines[1]) : null;
		const cont = markerMatch && lines.length > 2 && CONTINUES_LINE.test(lines[2]) ? lines[2].trimEnd() : null;
		sections.push({
			heading: h[1],
			n: Number(h[2]),
			date: h[3],
			sessionId: markerMatch ? markerMatch[1] : null,
			continues: cont,
			start,
			end,
		});
	}
	return sections;
}

export interface RenderSectionOptions {
	heading: string;
	sessionId: string;
	continues?: string | null;
	/** Blocks already joined with blank lines; may be empty. */
	content: string;
}

/** A session section, ending with exactly one newline. */
export function renderSessionSection(opts: RenderSectionOptions): string {
	let s = `## ${opts.heading}\n${sessionMarker(opts.sessionId)}\n`;
	if (opts.continues) s += `${opts.continues}\n`;
	if (opts.content) s += `\n${opts.content}\n`;
	return s;
}

export interface UpsertSessionOptions {
	sessionId: string;
	/** Local date for a new section's heading. */
	date: string;
	/** Regenerated backfill (blocks joined by blank lines). */
	content: string;
	/** Add `Continues [[#<previous heading>]].` to a NEW section when a previous one exists. */
	continuesPrevious?: boolean;
}

export interface UpsertSessionResult {
	text: string;
	/** true when a new section was appended (false: this session's section was regenerated). */
	created: boolean;
	heading: string;
	previousHeading: string | null;
}

/**
 * Make sure the note has a section for `sessionId`.
 * - If this session's marker exists, only that section (heading → next session heading / EOF)
 *   is regenerated; its heading and `Continues` line are kept (idempotent re-link).
 * - Otherwise a new section `## Session N (date)` is appended after the existing content,
 *   N = existing markers + 1. Everything before it stays byte-for-byte.
 */
export function upsertSessionSection(text: string, opts: UpsertSessionOptions): UpsertSessionResult {
	const sections = findSessionSections(text);
	const mine = sections.find((s) => s.sessionId === opts.sessionId);
	if (mine) {
		let section = renderSessionSection({
			heading: mine.heading,
			sessionId: opts.sessionId,
			continues: mine.continues,
			content: opts.content,
		});
		if (mine.end < text.length) section += "\n"; // blank line before the next section
		const idx = sections.indexOf(mine);
		return {
			text: text.slice(0, mine.start) + section + text.slice(mine.end),
			created: false,
			heading: mine.heading,
			previousHeading: idx > 0 ? sections[idx - 1].heading : null,
		};
	}
	const n = countSessionMarkers(text) + 1;
	const heading = sessionHeading(n, opts.date);
	const previous = sections.length > 0 ? sections[sections.length - 1] : null;
	const section = renderSessionSection({
		heading,
		sessionId: opts.sessionId,
		continues: opts.continuesPrevious && previous ? continuesLine(previous.heading) : null,
		content: opts.content,
	});
	const { body } = splitFrontmatter(text);
	let sep = "";
	if (body.length > 0) {
		if (!text.endsWith("\n")) sep = "\n\n";
		else if (!text.endsWith("\n\n")) sep = "\n";
	}
	return { text: text + sep + section, created: true, heading, previousHeading: previous ? previous.heading : null };
}

// ─── Mermaid fences ──────────────────────────────────────────────────────────

export interface MermaidFence {
	/** Diagram source between the fences (no fences, no final newline). */
	source: string;
	/** Offset of the opening fence line. */
	start: number;
	/** Offset just past the closing fence line (before its newline). */
	end: number;
	/** true when the block sits inside a `%%` comment (already hidden in the note). */
	hidden: boolean;
}

/** Closed ```mermaid fenced blocks, in document order. Fences of other languages are skipped over. */
export function findMermaidFences(markdown: string): MermaidFence[] {
	const out: MermaidFence[] = [];
	const lines = markdown.split("\n");
	const offsets: number[] = [];
	let pos = 0;
	for (const l of lines) {
		offsets.push(pos);
		pos += l.length + 1;
	}
	let i = 0;
	let inComment = false;
	while (i < lines.length) {
		const line = lines[i].replace(/\r$/, "");
		if (line.trim() === "%%") {
			inComment = !inComment;
			i++;
			continue;
		}
		const open = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
		if (!open) {
			i++;
			continue;
		}
		const fence = open[2];
		const lang = open[3].toLowerCase();
		let j = i + 1;
		let closed = -1;
		while (j < lines.length) {
			const l = lines[j].replace(/\r$/, "");
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
				closed = j;
				break;
			}
			j++;
		}
		if (closed === -1) break; // unclosed fence: runs to EOF, nothing after it is a block
		if (lang === "mermaid") {
			const src = lines.slice(i + 1, closed).map((l) => l.replace(/\r$/, "")).join("\n");
			out.push({
				source: src,
				start: offsets[i],
				end: offsets[closed] + lines[closed].replace(/\r$/, "").length,
				hidden: inComment,
			});
		}
		i = closed + 1;
	}
	return out;
}

/**
 * Replace each rejected fence with an Obsidian `%%` comment. The source stays
 * available for audit and resume parsing, but the draft is invisible to readers.
 */
export function hideMermaidBlocks(markdown: string, blocks: MermaidFence[]): string {
	let out = markdown;
	for (const b of [...blocks].sort((a, z) => z.start - a.start)) {
		const original = out.slice(b.start, b.end);
		out = `${out.slice(0, b.start)}%%\n${original}\n%%${out.slice(b.end)}`;
	}
	return out;
}

// ─── Resume brief ────────────────────────────────────────────────────────────

export type QuizVerdict = "correct" | "incorrect" | "I don't know" | "cancelled" | "unavailable" | "unanswered";

export interface QuizRecord {
	question: string;
	verdict: QuizVerdict;
}

/** Each `> [!question] Quiz` callout's question text, paired with the verdict of the answer callout after it. */
export function extractQuizHistory(text: string): QuizRecord[] {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	const records: QuizRecord[] = [];
	let pending: QuizRecord | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === "> [!question] Quiz") {
			if (pending) records.push(pending);
			const q: string[] = [];
			for (let j = i + 1; j < lines.length && lines[j].startsWith(">"); j++) {
				const body = lines[j].replace(/^> ?/, "");
				if (body.trim() === "") break;
				q.push(body);
			}
			pending = { question: q.join("\n").trim(), verdict: "unanswered" };
			continue;
		}
		const ans = /^> \[!\w+\] Quiz — (.+)$/.exec(line);
		if (ans && pending) {
			const t = ans[1];
			pending.verdict = t.startsWith("correct")
				? "correct"
				: t.startsWith("incorrect")
					? "incorrect"
					: t.startsWith("I don't know")
						? "I don't know"
						: t.startsWith("cancelled")
							? "cancelled"
							: t.startsWith("unavailable")
								? "unavailable"
								: "unanswered";
			records.push(pending);
			pending = null;
		}
	}
	if (pending) records.push(pending);
	return records;
}

/** `%% system: …` tag labels of visible concept diagrams, first occurrence order, deduplicated. */
export function extractSystemTags(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of findMermaidFences(text)) {
		if (f.hidden) continue;
		for (const l of f.source.split("\n")) {
			const m = /^\s*%%\s*system:\s*(.+?)\s*$/.exec(l);
			if (m && !seen.has(m[1])) {
				seen.add(m[1]);
				out.push(m[1]);
			}
		}
	}
	return out;
}

/** The last visible mermaid block tagged `%% dependency-map`, else the note's first visible mermaid block. */
export function pickDependencyMap(text: string): string | null {
	const fences = findMermaidFences(text).filter((f) => !f.hidden);
	const tagged = fences.filter((f) => /^\s*%%\s*dependency-map\b/m.test(f.source));
	if (tagged.length > 0) return tagged[tagged.length - 1].source;
	return fences.length > 0 ? fences[0].source : null;
}

/**
 * The last ~maxChars of the note body, cut at a block boundary (a blank line
 * followed by a callout or heading, else any blank line).
 */
export function transcriptTail(body: string, maxChars = 12000): { text: string; truncated: boolean } {
	const trimmed = body.replace(/\s+$/, "");
	if (trimmed.length <= maxChars) return { text: trimmed.replace(/^\s+/, ""), truncated: false };
	const from = trimmed.length - maxChars;
	const re = /\n\n(?=> \[!|#{1,6} )/g;
	re.lastIndex = from;
	let m = re.exec(trimmed);
	let cut = m ? m.index + 2 : -1;
	if (cut === -1) {
		const blank = trimmed.indexOf("\n\n", from);
		cut = blank === -1 ? from : blank + 2;
	}
	return { text: trimmed.slice(cut), truncated: true };
}

function protectFencedCode(text: string): { text: string; restore: (value: string) => string } {
	const normalized = text.replace(/\r\n/g, "\n");
	const fences: string[] = [];
	const segments: string[] = [];
	let lines: string[] = [];
	let fence: { char: string; length: number } | null = null;
	function flush(code: boolean): void {
		if (lines.length === 0) return;
		const content = lines.join("\n");
		segments.push(code ? `\uE000PI_LEARN_FENCE_${fences.push(content) - 1}\uE001` : content);
		lines = [];
	}
	for (const line of normalized.split("\n")) {
		if (!fence) {
			const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (open) {
				flush(false);
				fence = { char: open[1][0], length: open[1].length };
			}
			lines.push(line);
			continue;
		}
		lines.push(line);
		const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
		if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
			flush(true);
			fence = null;
		}
	}
	flush(fence !== null);
	return {
		text: segments.join("\n"),
		restore: (value: string) => value.replace(/\uE000PI_LEARN_FENCE_(\d+)\uE001/g, (_match, index: string) => fences[Number(index)] ?? ""),
	};
}

function trimOuterBlankLines(text: string): string {
	return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

/** Remove injected skill wrappers while preserving a learner's fenced XML examples. */
export function stripInjectedSkillBlocks(text: string): string {
	const fenced = protectFencedCode(text);
	return trimOuterBlankLines(fenced.restore(fenced.text.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/gi, "")));
}

/**
 * Keep reader-facing explanation, while dropping clearly internal narration.
 * Pi's native `thinking` blocks are excluded by the caller. Some models also
 * emit tagged reasoning inside a text block, or short status paragraphs before
 * a tool call. Only those unmistakable forms are removed here: an unfamiliar
 * paragraph is kept so a real explanation cannot silently disappear.
 */
export function lessonPresentationText(text: string): string {
	// A lesson may legitimately show XML such as `<analysis>` in a code sample.
	const fenced = protectFencedCode(text);
	const withoutReasoning = fenced.text
		.replace(/<(think|thinking|analysis|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	const progress = [
		/^(?:i['’]ll|i will|let me)\s+(?:start by\s+)?(?:map|mapping|probe|assess)\b.*\b(?:your understanding|your knowledge|where you|background research)\b/i,
		/^(?:i['’]ll|i will|let me)\s+(?:kick off|extract|pull|read|fetch)\b.*\b(?:background research|agent(?:['’]s)? transcript|research results|source results)\b/i,
		/^(?:the\s+)?research\s+(?:has\s+)?(?:landed|is back|came back)[.!?]?$/i,
		/^(?:one|two|three|four|five|\d+)\s+for\s+(?:one|two|three|four|five|\d+)\b.*\b(?:push|jump|probe|plan|research|escalat)/i,
		/^(?:good|great|perfect)\s*[—,!–-].*\b(?:probe|escalat|two more|next question|plan|research|data point)\b/i,
	];
	const paragraphs = withoutReasoning.split(/\n[ \t]*\n+/);
	const kept: string[] = [];
	for (const paragraph of paragraphs) {
		// A status sentence may share a paragraph with a useful observation.
		// Remove only that sentence; never discard the observation after it.
		const candidate = paragraph.replace(/^(?:the\s+)?research\s+(?:has\s+)?(?:landed|is back|came back)[.!?]\s+(?=\S)/i, "");
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		if (!candidate.includes("\uE000PI_LEARN_FENCE_") && trimmed.length <= 400 && progress.some((pattern) => pattern.test(trimmed))) continue;
		kept.push(candidate);
	}
	return trimOuterBlankLines(fenced.restore(kept.join("\n\n")));
}

export interface ResumeBriefOptions {
	/** Note basename without `.md`. */
	noteName: string;
	/** Heading of the section the resumed session writes into, if known. */
	newHeading?: string;
	tailChars?: number;
}

function oneLine(s: string, max = 240): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Deterministic resume brief built from the note text (sent hidden to the tutor). */
export function buildResumeBrief(noteText: string, opts: ResumeBriefOptions): string {
	const fm = readFrontmatter(noteText) ?? {};
	const topicValue = fm["learn-topic"];
	const topic = typeof topicValue === "string" && topicValue.trim() ? topicValue.trim() : opts.noteName;
	const { body } = splitFrontmatter(noteText);
	const sections = findSessionSections(noteText);
	const depMap = pickDependencyMap(noteText);
	const systems = extractSystemTags(noteText);
	const quizzes = extractQuizHistory(body);
	const tail = transcriptTail(body, opts.tailChars ?? 12000);

	const out: string[] = [];
	out.push("[pi-learn resume brief — generated from the learner's Obsidian note; the learner did not type this]");
	out.push("");
	out.push(`Topic: ${topic}`);
	out.push(`Note: ${opts.noteName}.md`);
	out.push("");
	out.push("## Sessions so far");
	if (sections.length === 0) out.push("- (no session sections — an older note; see the transcript below)");
	for (const s of sections) out.push(`- ${s.heading}`);
	if (opts.newHeading) out.push(`This new session is logged under: ${opts.newHeading}`);
	out.push("");
	out.push("## Latest dependency map");
	if (depMap) out.push("```mermaid", depMap, "```");
	else out.push("(none found in the note)");
	out.push("");
	out.push("## Concept diagrams already drawn");
	if (systems.length === 0) out.push("(none)");
	for (const s of systems) out.push(`- ${s}`);
	out.push("");
	out.push("## Quiz history (oldest first)");
	if (quizzes.length === 0) out.push("(no quizzes yet)");
	quizzes.forEach((q, i) => out.push(`${i + 1}. [${q.verdict}] ${oneLine(q.question)}`));
	out.push("");
	out.push(`## Recent note content${tail.truncated ? " (earlier part omitted)" : ""}`);
	out.push("<note-tail>");
	out.push(tail.text);
	out.push("</note-tail>");
	out.push("");
	out.push("## Instructions");
	out.push("You are resuming this lesson from the learner's Obsidian note above; it is not a new lesson.");
	out.push("- Do not restart the probe from scratch — the quiz history shows what has already been checked.");
	out.push("- Briefly re-establish where we stopped (2–3 sentences) and name the next node of the dependency map.");
	out.push("- If you are unsure the last node landed, re-check it with one quiz before building on it.");
	out.push(
		"- Then continue the teach loop (motivate → establish → connect → quiz-check), keeping all the teach-skill rules, including Mermaid diagrams for systems.",
	);
	return out.join("\n");
}

// ─── Index note ──────────────────────────────────────────────────────────────

export interface NoteSummary {
	basename: string;
	topic: string;
	status: string;
	sessions: number;
	/** `YYYY-MM-DD HH:mm` */
	lastStudied: string;
	/** ms since epoch, for ordering (learn-updated, else file mtime). */
	sortKey: number;
}

function formatStampFromMs(ms: number): string {
	const d = new Date(ms);
	return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Summary of a learning note (frontmatter has `learn-topic`), or null for any other note. */
export function summarizeNote(text: string, basename: string, mtimeMs: number): NoteSummary | null {
	if (basename === INDEX_BASENAME) return null;
	const fm = readFrontmatter(text);
	if (!fm || !("learn-topic" in fm)) return null;
	const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
	const topic = str(fm["learn-topic"]) || basename;
	const status = str(fm["learn-status"]) || "";
	const list = fm["learn-sessions"];
	const listed = Array.isArray(list) ? list.length : list ? 1 : 0;
	const sessions = Math.max(listed, countSessionMarkers(text));
	const updated = str(fm["learn-updated"]);
	const parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(updated) ? new Date(updated).getTime() : Number.NaN;
	const sortKey = Number.isFinite(parsed) ? parsed : mtimeMs;
	return {
		basename,
		topic,
		status,
		sessions,
		lastStudied: Number.isFinite(parsed) ? updated.replace("T", " ") : formatStampFromMs(mtimeMs),
		sortKey,
	};
}

/** Newest first; ties by name. */
export function sortSummaries(summaries: NoteSummary[]): NoteSummary[] {
	return [...summaries].sort((a, b) => b.sortKey - a.sortKey || a.basename.localeCompare(b.basename));
}

export function pickMostRecent(summaries: NoteSummary[]): NoteSummary | null {
	return sortSummaries(summaries)[0] ?? null;
}

function cell(s: string): string {
	return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** The machine-owned `Learn Index.md` (fully rewritten each time). */
export function buildIndexNote(summaries: NoteSummary[]): string {
	const rows = sortSummaries(summaries.filter((s) => s.basename !== INDEX_BASENAME));
	const lines = [
		"Learning notes created by pi-learn, newest first. This note is regenerated automatically when you link or resume a learning note — edits here are overwritten.",
		"",
		"| Note | Topic | Status | Sessions | Last studied |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const s of rows) {
		lines.push(`| [[${s.basename}]] | ${cell(s.topic)} | ${cell(s.status)} | ${s.sessions} | ${s.lastStudied} |`);
	}
	return `${lines.join("\n")}\n`;
}
