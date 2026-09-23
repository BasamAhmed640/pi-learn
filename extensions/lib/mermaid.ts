// Mermaid extraction, validation and cheap static metrics (contract: docs/CONTRACTS.md section 1).
//
// Validation runs the real Mermaid parser pinned to the version Obsidian bundles, inside a
// long-lived worker thread (mermaid-worker.mjs). Mermaid needs a DOM; the DOM shim lives only in
// the worker, so pi's main thread (and its terminal UI) never gains `window`/`document` globals.
import { Worker } from "node:worker_threads";

export const OBSIDIAN_MERMAID_VERSION = "11.13.0"; // what Obsidian bundles on this machine

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

export interface MermaidBlock {
	source: string; // the diagram source between the fences (no fences, trimmed of the final newline)
	start: number; // char offset of the opening fence in the markdown
	end: number; // char offset just past the closing fence
}

interface Line {
	text: string; // without the line terminator
	offset: number; // offset of the line's first character in the markdown
}

function splitLines(markdown: string): Line[] {
	const lines: Line[] = [];
	let offset = 0;
	while (offset <= markdown.length) {
		const nl = markdown.indexOf("\n", offset);
		const endIndex = nl === -1 ? markdown.length : nl;
		let text = markdown.slice(offset, endIndex);
		if (text.endsWith("\r")) text = text.slice(0, -1);
		lines.push({ text, offset });
		if (nl === -1) break;
		offset = nl + 1;
	}
	return lines;
}

// Strip one Obsidian callout / blockquote marker: optional indentation, `>`, one optional space.
function stripQuote(text: string): { content: string; skipped: number } | null {
	const m = /^ {0,3}> ?/.exec(text);
	return m ? { content: text.slice(m[0].length), skipped: m[0].length } : null;
}

const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Find ```mermaid / ~~~mermaid fenced blocks, including blocks inside callouts where every line
 * starts with `>`. Other fenced blocks are skipped (a ```mermaid line inside them is code, not a
 * diagram). Unterminated fences are ignored. `start` is the offset of the first fence character of
 * the opening fence; `end` is just past the last fence character of the closing fence.
 */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
	const blocks: MermaidBlock[] = [];
	if (typeof markdown !== "string" || markdown.length === 0) return blocks;
	const lines = splitLines(markdown);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// Try the line as-is first, then as a callout line.
		let quoted = false;
		let skipped = 0;
		let open = OPEN_FENCE.exec(line.text);
		if (!open) {
			const q = stripQuote(line.text);
			if (q) {
				open = OPEN_FENCE.exec(q.content);
				if (open) {
					quoted = true;
					skipped = q.skipped;
				}
			}
		}
		if (!open) {
			i++;
			continue;
		}
		const fence = open[2];
		const info = open[3];
		if (fence[0] === "`" && info.includes("`")) {
			// Not a fence (backtick fences cannot have backticks in the info string).
			i++;
			continue;
		}
		const isMermaid = /^\s*mermaid\s*$/i.test(info);
		const fenceChar = fence[0] === "`" ? "`" : "~";
		const close = new RegExp(`^ {0,3}(\\${fenceChar}{${fence.length},})\\s*$`);
		const body: string[] = [];
		let closed = -1;
		let closeEnd = -1;
		let j = i + 1;
		for (; j < lines.length; j++) {
			let inner = lines[j].text;
			let innerSkipped = 0;
			if (quoted) {
				const q = stripQuote(inner);
				if (!q) break; // the callout ended before the fence closed
				inner = q.content;
				innerSkipped = q.skipped;
			}
			const c = close.exec(inner);
			if (c) {
				closed = j;
				const fenceStart = inner.indexOf(c[1]);
				closeEnd = lines[j].offset + innerSkipped + fenceStart + c[1].length;
				break;
			}
			body.push(inner);
		}
		if (closed === -1) {
			// Unterminated. Outside a callout the fence swallows the rest of the document (CommonMark),
			// so nothing after it is a diagram; inside a callout, scanning resumes where the callout ended.
			if (!quoted) break;
			i = j;
			continue;
		}
		if (isMermaid) {
			blocks.push({
				source: body.join("\n"),
				start: line.offset + skipped + open[1].length,
				end: closeEnd,
			});
		}
		i = closed + 1;
	}
	return blocks;
}

// ---------------------------------------------------------------------------------------------
// Validation (worker thread)
// ---------------------------------------------------------------------------------------------

export type MermaidValidation =
	| { status: "valid"; diagramType: string }
	| { status: "invalid"; error: string } // real syntax error: ask for a repair
	| { status: "unavailable"; error: string }; // validator could not run: fail open

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_LIMIT = 500;

interface WorkerReply {
	id: number;
	status: "valid" | "invalid" | "unavailable";
	diagramType?: string;
	error?: string;
}

let worker: Worker | null = null;
let workerStartError: string | null = null;
let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, MermaidValidation>();
const inflight = new Map<string, Promise<MermaidValidation>>();

function errorText(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
	return String(error);
}

function workerUrl(): URL {
	return new URL("./mermaid-worker.mjs", import.meta.url);
}

function getWorker(): Worker {
	if (worker) return worker;
	const created = new Worker(workerUrl(), {
		execArgv: [],
		stdout: true, // do not pipe worker output into pi's terminal
		stderr: true,
		resourceLimits: { maxOldGenerationSizeMb: 512 },
	});
	// An idle validator never keeps the process alive. Worker stdout/stderr are captured (the worker
	// silences console anyway) but deliberately not read: a flowing stdio stream would ref the port.
	created.unref();
	// Permanent listeners: an unhandled 'error' event would otherwise crash the host process.
	created.on("error", (error: unknown) => {
		workerStartError = errorText(error);
		if (worker === created) worker = null;
	});
	created.on("exit", () => {
		if (worker === created) worker = null;
	});
	worker = created;
	return created;
}

function discardWorker(target: Worker): void {
	if (worker === target) worker = null;
	target.terminate().catch(() => {});
}

function runInWorker(source: string): Promise<MermaidValidation> {
	return new Promise<MermaidValidation>((resolve) => {
		let target: Worker;
		try {
			target = getWorker();
		} catch (error) {
			resolve({ status: "unavailable", error: `Mermaid validator could not start: ${errorText(error)}` });
			return;
		}
		const id = ++nextId;
		let settled = false;
		const finish = (result: MermaidValidation) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			target.off("message", onMessage);
			target.off("error", onError);
			target.off("exit", onExit);
			resolve(result);
		};
		const onMessage = (reply: WorkerReply) => {
			if (!reply || reply.id !== id) return;
			if (reply.status === "valid") finish({ status: "valid", diagramType: String(reply.diagramType ?? "") });
			else if (reply.status === "invalid") finish({ status: "invalid", error: String(reply.error ?? "Invalid Mermaid") });
			else finish({ status: "unavailable", error: String(reply.error ?? "Mermaid validator unavailable") });
		};
		const onError = (error: unknown) => {
			finish({ status: "unavailable", error: `Mermaid validator crashed: ${errorText(error)}` });
		};
		const onExit = (code: number) => {
			finish({
				status: "unavailable",
				error: workerStartError ? `Mermaid validator exited: ${workerStartError}` : `Mermaid validator exited with code ${code}`,
			});
		};
		// This timer is deliberately ref'd: it keeps the process alive for at most 10 s while a
		// request is in flight, so the (unref'd) worker's reply is not lost on an otherwise idle loop.
		const timer = setTimeout(() => {
			discardWorker(target);
			finish({ status: "unavailable", error: `Mermaid validation timed out after ${REQUEST_TIMEOUT_MS / 1000} s` });
		}, REQUEST_TIMEOUT_MS);
		target.on("message", onMessage);
		target.on("error", onError);
		target.on("exit", onExit);
		try {
			target.postMessage({ id, source });
		} catch (error) {
			discardWorker(target);
			finish({ status: "unavailable", error: `Mermaid validator could not be reached: ${errorText(error)}` });
		}
	});
}

function remember(source: string, result: MermaidValidation): void {
	if (result.status === "unavailable") return; // retry next time
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(source, result);
}

/**
 * Parse `source` with the real Mermaid parser (the version Obsidian bundles), i.e. the same check
 * that decides whether Obsidian renders the diagram or shows "Syntax error". Never throws.
 * `diagramType` on a valid result is Mermaid's own id (e.g. "flowchart-v2", "sequence",
 * "stateDiagram", "class", "er", "mindmap", "timeline").
 */
export async function validateMermaid(source: string): Promise<MermaidValidation> {
	try {
		const text = typeof source === "string" ? source : String(source ?? "");
		const cached = cache.get(text);
		if (cached) return cached;
		const pending = inflight.get(text);
		if (pending) return await pending;
		const run = queue.then(() => runInWorker(text));
		const guarded = run.then(
			(result) => {
				remember(text, result);
				return result;
			},
			(error: unknown): MermaidValidation => ({ status: "unavailable", error: errorText(error) }),
		);
		queue = guarded.catch(() => undefined);
		inflight.set(text, guarded);
		try {
			return await guarded;
		} finally {
			inflight.delete(text);
		}
	} catch (error) {
		return { status: "unavailable", error: `Mermaid validation failed to run: ${errorText(error)}` };
	}
}

// ---------------------------------------------------------------------------------------------
// Static description (cheap, approximate)
// ---------------------------------------------------------------------------------------------

export interface MermaidTag {
	kind: "system" | "dependency-map";
	label?: string; // system name (for zoom tags: the parent system's name)
	level?: "overview" | "zoom";
	subsystem?: string; // zoom tags only: the part being zoomed into
}
export interface MermaidShape {
	diagramType: string;
	tag?: MermaidTag;
	nodes: number;
	edges: number;
}

interface ContentLine {
	text: string; // comment-free, trimmed
}

function contentLines(source: string): { type: string; typeLine: string; body: ContentLine[]; comments: string[] } {
	const raw = source.replace(/\r/g, "").split("\n");
	let i = 0;
	// YAML frontmatter
	while (i < raw.length && raw[i].trim() === "") i++;
	if (i < raw.length && raw[i].trim() === "---") {
		let j = i + 1;
		while (j < raw.length && raw[j].trim() !== "---") j++;
		i = j < raw.length ? j + 1 : i;
	}
	const comments: string[] = [];
	let type = "";
	let typeLine = "";
	const body: ContentLine[] = [];
	for (; i < raw.length; i++) {
		const trimmed = raw[i].trim();
		if (trimmed.startsWith("%%")) {
			if (!trimmed.startsWith("%%{")) comments.push(trimmed);
			continue;
		}
		if (trimmed === "") continue;
		if (!type) {
			typeLine = trimmed;
			const m = /^[A-Za-z][\w-]*/.exec(trimmed);
			type = m ? m[0] : trimmed;
			continue;
		}
		body.push({ text: trimmed });
	}
	return { type, typeLine, body, comments };
}

function normaliseType(type: string): string {
	if (type === "graph" || type === "flowchart-elk") return "flowchart";
	return type;
}

const TAG_SEPARATOR = "\\s*[\\u2014\\u2013-]\\s*";
const SYSTEM_TAG = new RegExp(`^%%\\s*system\\s*:\\s*(.+?)(?:${TAG_SEPARATOR}(overview|zoom)(?:\\s*:\\s*(.*?))?)?\\s*$`, "i");
const DEPENDENCY_TAG = /^%%\s*dependency[-\s]map\b(?:\s*(?::|[—–-])\s*(.*?))?\s*$/i;

function parseTag(comments: string[]): MermaidTag | undefined {
	for (const comment of comments) {
		const dep = DEPENDENCY_TAG.exec(comment);
		if (dep) return dep[1] ? { kind: "dependency-map", label: dep[1] } : { kind: "dependency-map" };
		const sys = SYSTEM_TAG.exec(comment);
		if (sys) {
			const tag: MermaidTag = { kind: "system", label: sys[1].trim() };
			if (sys[2]) {
				tag.level = sys[2].toLowerCase() === "zoom" ? "zoom" : "overview";
				if (tag.level === "zoom" && sys[3] && sys[3].trim()) tag.subsystem = sys[3].trim();
			}
			return tag;
		}
	}
	return undefined;
}

function stripInlineComment(text: string): string {
	const idx = text.indexOf("%%");
	return idx === -1 ? text : text.slice(0, idx).trim();
}

// --- flowchart -------------------------------------------------------------------------------

const FLOW_SKIP = /^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b/;
const FLOW_SHAPES: RegExp[] = [
	/@\{[^}]*\}/g,
	/\(\(\([^]*?\)\)\)/g,
	/\(\([^]*?\)\)/g,
	/\(\[[^]*?\]\)/g,
	/\[\[[^]*?\]\]/g,
	/\[\([^]*?\)\]/g,
	/\{\{[^]*?\}\}/g,
	/\[[/\\][^]*?[/\\]\]/g,
	/\[[^\]]*\]/g,
	/\([^)]*\)/g,
	/\{[^}]*\}/g,
];
const FLOW_LINK =
	/\s*(?:(?<=\s|^)[xo](?=[-=]))?(?:<?-{2,}>|<?-{2,}[xo](?=\s|$|[\p{L}\p{N}_])|<?-{3,}|<?={2,}>|<?={2,}[xo](?=\s|$)|<?={3,}|<?-\.+->|<?-\.+-[xo](?=\s|$)|-\.+-|~{3,})\s*/gu;

function describeFlowchart(body: ContentLine[]): { nodes: number; edges: number } {
	const nodes = new Set<string>();
	let edges = 0;
	for (const { text } of body) {
		let line = stripInlineComment(text);
		if (!line || FLOW_SKIP.test(line)) continue;
		line = line.replace(/"[^"]*"/g, "");
		line = line.replace(/\|[^|]*\|/g, "");
		for (const shape of FLOW_SHAPES) line = line.replace(shape, "");
		line = line.replace(/(\w)>[^\]]*\]/g, "$1"); // asymmetric shape A>text]
		// Edge text forms: A -- text --> B, A == text ==> B, A -. text .-> B
		line = line.replace(/(^|\s)--(?![-.>]|[xo](?:\s|$))\s*[^-]+?\s*(--[->xo]|---)/g, "$1$2");
		line = line.replace(/(^|\s)==(?![=>])\s*[^=]+?\s*(==[=>xo])/g, "$1$2");
		line = line.replace(/(^|\s)-\.(?![-.])\s*[^.]+?\s*(\.-[>xo]?)/g, "$1-$2");
		for (const statement of line.split(";")) {
			const groups = statement
				.split(FLOW_LINK)
				.map((segment) =>
					segment
						.split("&")
						.map((id) => id.replace(/:::[\w-]+/g, "").trim())
						.filter((id) => /^[\p{L}\p{N}_][\p{L}\p{N}_.\-]*$/u.test(id)),
				);
			const nonEmpty = groups.filter((group) => group.length > 0);
			for (const group of nonEmpty) for (const id of group) nodes.add(id);
			for (let k = 1; k < groups.length; k++) {
				if (groups[k - 1].length && groups[k].length) edges += groups[k - 1].length * groups[k].length;
			}
		}
	}
	return { nodes: nodes.size, edges };
}

// --- sequence ---------------------------------------------------------------------------------

const SEQ_SKIP =
	/^(note|loop|alt|else|opt|par|par_over|and|critical|option|break|rect|end|activate|deactivate|autonumber|box|title|link|links|properties|details|accTitle|accDescr)\b/i;
const SEQ_ARROW = /^(.*?)\s*(<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*(.*)$/;

function describeSequence(body: ContentLine[]): { nodes: number; edges: number } {
	const participants = new Set<string>();
	let edges = 0;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line) continue;
		const decl = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:@\{.*\})?(?:\s+as\s+.*)?$/i.exec(line);
		if (decl) {
			participants.add(decl[2].trim());
			continue;
		}
		if (/^destroy\s+/i.test(line) || SEQ_SKIP.test(line)) continue;
		const colon = line.indexOf(":");
		const head = colon === -1 ? line : line.slice(0, colon);
		const m = SEQ_ARROW.exec(head);
		if (!m || !m[1].trim() || !m[3].trim()) continue;
		participants.add(m[1].trim());
		participants.add(m[3].trim());
		edges++;
	}
	return { nodes: participants.size, edges };
}

// --- state ------------------------------------------------------------------------------------

const STATE_ID = "(\\[\\*\\]|[\\p{L}\\p{N}_.]+)";
const STATE_TRANSITION = new RegExp(`^${STATE_ID}\\s*-->\\s*${STATE_ID}`, "u");

function describeState(body: ContentLine[]): { nodes: number; edges: number } {
	const states = new Set<string>();
	let edges = 0;
	let inNote = false;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line) continue;
		if (inNote) {
			if (/^end\s+note\b/i.test(line)) inNote = false;
			continue;
		}
		if (/^note\b/i.test(line)) {
			if (!line.includes(":")) inNote = true;
			continue;
		}
		if (/^(direction|classDef|class|style|accTitle|accDescr|title|\}|--)\b/.test(line) || line === "}" || line === "--") continue;
		const t = STATE_TRANSITION.exec(line);
		if (t) {
			states.add(t[1]);
			states.add(t[2]);
			edges++;
			continue;
		}
		const decl = /^state\s+(?:"[^"]*"\s+as\s+)?([\p{L}\p{N}_.]+)/u.exec(line);
		if (decl) {
			states.add(decl[1]);
			continue;
		}
		const desc = /^([\p{L}\p{N}_.]+)\s*:/u.exec(line);
		if (desc) states.add(desc[1]);
	}
	return { nodes: states.size, edges };
}

// --- class ------------------------------------------------------------------------------------

const CLASS_NAME = "([\\p{L}\\p{N}_.]+)(?:~[^~]*~)?";
const CLASS_REL = new RegExp(
	`^${CLASS_NAME}\\s*(?:"[^"]*"\\s*)?(<\\|--|<\\|\\.\\.|\\*--|o--|<--|<\\.\\.|--\\|>|\\.\\.\\|>|--\\*|--o|-->|\\.\\.>|--|\\.\\.)(?:\\|>|>|\\*|o)?\\s*(?:"[^"]*"\\s*)?${CLASS_NAME}`,
	"u",
);

function describeClass(body: ContentLine[]): { nodes: number; edges: number } {
	const classes = new Set<string>();
	let edges = 0;
	let depth = 0;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line) continue;
		if (depth > 0) {
			if (line.includes("}")) depth--;
			continue;
		}
		const decl = /^class\s+([\p{L}\p{N}_.]+)/u.exec(line);
		if (decl) {
			classes.add(decl[1]);
			if (line.includes("{") && !line.includes("}")) depth++;
			continue;
		}
		const ns = /^namespace\s+/.exec(line);
		if (ns) continue; // namespace blocks contain class declarations on their own lines
		if (line === "}") continue;
		if (/^(note|classDef|style|cssClass|callback|link|click|direction|accTitle|accDescr|title)\b/.test(line)) continue;
		if (/^<<[^>]*>>/.test(line)) continue;
		const rel = CLASS_REL.exec(line);
		if (rel) {
			classes.add(rel[1]);
			classes.add(rel[3]);
			edges++;
			continue;
		}
		const member = /^([\p{L}\p{N}_.]+)\s*:/u.exec(line);
		if (member) classes.add(member[1]);
	}
	return { nodes: classes.size, edges };
}

// --- er ---------------------------------------------------------------------------------------

const ER_ENTITY = '("[^"]+"|[\\p{L}\\p{N}_-]+)';
const ER_REL = new RegExp(`^${ER_ENTITY}\\s*([|}][|o]|\\|\\|)(--|\\.\\.)([|o][|{]|\\|\\|)\\s*${ER_ENTITY}`, "u");

function describeEr(body: ContentLine[]): { nodes: number; edges: number } {
	const entities = new Set<string>();
	let edges = 0;
	let depth = 0;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line) continue;
		if (depth > 0) {
			if (line.includes("}")) depth--;
			continue;
		}
		const rel = ER_REL.exec(line);
		if (rel) {
			entities.add(rel[1].replace(/"/g, ""));
			entities.add(rel[5].replace(/"/g, ""));
			edges++;
			continue;
		}
		if (/^(direction|classDef|class|style|accTitle|accDescr|title)\b/.test(line)) continue;
		const block = new RegExp(`^${ER_ENTITY}\\s*(?:\\[[^\\]]*\\])?\\s*(\\{)?\\s*$`, "u").exec(line);
		if (block) {
			entities.add(block[1].replace(/"/g, ""));
			if (block[2]) depth++;
		}
	}
	return { nodes: entities.size, edges };
}

// --- mindmap / others -------------------------------------------------------------------------

function describeMindmap(body: ContentLine[]): { nodes: number; edges: number } {
	let nodes = 0;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line || /^::icon\(/.test(line) || /^:::/.test(line)) continue;
		nodes++;
	}
	return { nodes, edges: Math.max(0, nodes - 1) };
}

function describeGeneric(body: ContentLine[]): { nodes: number; edges: number } {
	let nodes = 0;
	for (const { text } of body) {
		const line = stripInlineComment(text);
		if (!line || /^(title|section|accTitle|accDescr|dateFormat|axisFormat)\b/.test(line)) continue;
		nodes++;
	}
	return { nodes, edges: 0 };
}

/** Cheap static metrics for a diagram source. Counts are approximate. Never throws. */
export function describeMermaid(source: string): MermaidShape {
	let diagramType = "unknown";
	let tag: MermaidTag | undefined;
	try {
		const { type, body, comments } = contentLines(typeof source === "string" ? source : String(source ?? ""));
		diagramType = type ? normaliseType(type) : "unknown";
		tag = parseTag(comments);
		let counts: { nodes: number; edges: number };
		switch (diagramType) {
			case "flowchart":
				counts = describeFlowchart(body);
				break;
			case "sequenceDiagram":
				counts = describeSequence(body);
				break;
			case "stateDiagram":
			case "stateDiagram-v2":
				counts = describeState(body);
				break;
			case "classDiagram":
			case "classDiagram-v2":
				counts = describeClass(body);
				break;
			case "erDiagram":
				counts = describeEr(body);
				break;
			case "mindmap":
				counts = describeMindmap(body);
				break;
			default:
				counts = describeGeneric(body);
		}
		const shape: MermaidShape = { diagramType, nodes: counts.nodes, edges: counts.edges };
		if (tag) shape.tag = tag;
		return shape;
	} catch {
		const shape: MermaidShape = { diagramType, nodes: 0, edges: 0 };
		if (tag) shape.tag = tag;
		return shape;
	}
}
