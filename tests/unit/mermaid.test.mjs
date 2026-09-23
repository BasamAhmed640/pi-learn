// Unit tests for extensions/lib/mermaid.ts. Validation verdicts are the empirical behaviour of the
// real mermaid@11.13.0 parser (the version Obsidian bundles), not what we would like it to be.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	OBSIDIAN_MERMAID_VERSION,
	describeMermaid,
	extractMermaidBlocks,
	validateMermaid,
} from "../../extensions/lib/mermaid.ts";

const TAG = "%% system: Fetch-decode-execute cycle — overview";

// [name, source, mermaid's diagramType]
const VALID = [
	["flowchart", "flowchart LR\n  A[Fetch] --> B[Decode] --> C[Execute]", "flowchart-v2"],
	["graph TD with semicolons", "graph TD;\n  A-->B;\n  B-->C;", "flowchart-v2"],
	["flowchart subgraphs + direction", "flowchart TB\n  subgraph cpu[\"CPU (core)\"]\n    direction LR\n    ALU --> REG\n  end\n  subgraph Memory System\n    RAM\n  end\n  cpu --> RAM", "flowchart-v2"],
	["flowchart labelled edges (all forms)", 'flowchart LR\n  A -->|reads| B\n  B -- writes --> C\n  C -.->|"maybe (async)"| D\n  D == strong ==> E\n  A -- "calls f(x)" --> E', "flowchart-v2"],
	["flowchart feedback back-edge", "flowchart LR\n  PC --> Fetch --> Decode --> Execute\n  Execute -.->|PC += 4| PC", "flowchart-v2"],
	["flowchart <br/> in labels", 'flowchart TD\n  A[Line one<br/>line two] --> B["x<br>y"]', "flowchart-v2"],
	["flowchart quoted label with parentheses", 'flowchart LR\n  A["Foo (bar)"] --> B["List [x, y] {z}"]', "flowchart-v2"],
	["flowchart unicode labels and ids", "flowchart LR\n  Größe[Größe → Ergebnis ✓] --> B[日本語 🚀]", "flowchart-v2"],
	["flowchart shapes", "flowchart LR\n  A((Start)) --> B([Stop]) --> C[(DB)] --> D[[Sub]] --> E{{Hex}} --> F{Ok?}", "flowchart-v2"],
	["flowchart & fan-out, classDef, style", "flowchart LR\n  A --> B & C --> D\n  A:::hot\n  classDef hot fill:#f96\n  style D fill:#9f6", "flowchart-v2"],
	["flowchart node id End (capitalised)", "flowchart LR\n  Start --> End", "flowchart-v2"],
	["flowchart comment on its own line", "flowchart LR\n  %% a comment\n  A --> B", "flowchart-v2"],
	["flowchart YAML frontmatter", "---\ntitle: Hello\n---\nflowchart LR\n  A --> B", "flowchart-v2"],
	["sequenceDiagram", "sequenceDiagram\n  participant C as Client (web)\n  actor U as User\n  U->>C: click\n  C->>+S: GET /x (json)\n  S-->>-C: 200\n  Note over C,S: TLS\n  alt ok\n    C-)Q: enqueue\n  else fail\n    C--xS: cancel\n  end", "sequence"],
	["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start f(x)\n  state Busy {\n    [*] --> Working\n    Working --> [*]\n  }\n  Busy --> [*]", "stateDiagram"],
	["stateDiagram (v1)", "stateDiagram\n  [*] --> A\n  A --> [*]", "stateDiagram"],
	["classDiagram", "classDiagram\n  Animal <|-- Duck\n  Duck *-- Beak\n  Customer \"1\" --> \"*\" Order : places\n  class Duck {\n    +String beak\n    +swim(int depth) bool\n  }\n  class List~T~", "class"],
	["erDiagram", "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains\n  CUSTOMER {\n    string name PK\n  }", "er"],
	["mindmap", "mindmap\n  root((CPU))\n    ALU\n    Control unit\n      Decoder (instr)\n    Größe ✓", "mindmap"],
	["timeline", "timeline\n  title History\n  1990 : Web (CERN)\n  2007 : iPhone : Android", "timeline"],
];

// The tag convention must not break any diagram type: tag line right after the type line.
function withTag(source) {
	const lines = source.split("\n");
	const typeIndex = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
	lines.splice(typeIndex + 1, 0, TAG);
	return lines.join("\n");
}

// [name, source, error pattern] — typical LLM mistakes, confirmed invalid in 11.13.0.
const INVALID = [
	["unquoted parentheses in [] label", "flowchart LR\n  A[Foo (bar)] --> B", /line 2.*unexpected 'PS'/],
	["unquoted parentheses in () label", "flowchart LR\n  A(Foo (bar)) --> B", /line 2/],
	["unquoted parentheses in {} label", "flowchart LR\n  A{f(x) ok?} --> B", /line 2/],
	["unquoted parentheses in |edge| label", "flowchart LR\n  A -->|calls f(x)| B", /line 2/],
	["unquoted parentheses in subgraph title", "flowchart LR\n  subgraph sys[My System (core)]\n    A --> B\n  end", /line 2/],
	["unquoted brackets in label", "flowchart LR\n  A[Foo [bar]] --> B", /unexpected 'SQS'/],
	["unquoted braces in label", "flowchart LR\n  A[Foo {bar}] --> B", /line 2/],
	["double quotes inside unquoted label", 'flowchart LR\n  A[Say "hi"] --> B', /line 2/],
	["label starting with /", "flowchart LR\n  A[/path] --> B", /Lexical error on line 2/],
	["empty label", "flowchart LR\n  A[] --> B", /line 2/],
	["label containing @", "flowchart LR\n  A[@user] --> B", /line 2/],
	["node id end (target)", "flowchart LR\n  A --> end", /unexpected 'end'/],
	["node id end (source)", "flowchart LR\n  end --> A", /unexpected 'end'/],
	["node ids class / style", "flowchart LR\n  class --> B", /line 2/],
	["node id with a space", "flowchart LR\n  Node A --> Node B", /line 2/],
	["unbalanced bracket", "flowchart LR\n  A[Foo --> B", /end of input/],
	["unclosed subgraph", "flowchart LR\n  subgraph S\n    A --> B", /end of input/],
	["stray end", "flowchart LR\n  A --> B\n  end", /unexpected 'end'/],
	["missing diagram type", "A --> B", /No diagram type detected/],
	["markdown heading before type", "## Diagram\nflowchart LR\n  A --> B", /No diagram type detected/],
	["whole fenced block passed as source", "```mermaid\nflowchart LR\n  A --> B\n```", /No diagram type detected/],
	["-> arrow in flowchart", "flowchart LR\n  A -> B", /unexpected 'MINUS'/],
	["unicode arrow in flowchart", "flowchart LR\n  A → B", /Lexical error/],
	["em-dash arrow in flowchart", "flowchart LR\n  A —> B", /Lexical error/],
	["sequence-style ': label' on flowchart edge", "flowchart LR\n  A --> B: label", /line 2/],
	["trailing %% comment on a code line", "flowchart LR\n  A --> B %% trailing", /line 2/],
	["stray prose after the diagram", "flowchart LR\n  A --> B\nThis diagram shows the flow.", /line 3/],
	["markdown bullet inside diagram", "flowchart LR\n  - A --> B", /line 2/],
	["lowercase direction", "flowchart td\n  A --> B", /Lexical error on line 1/],
	["note in flowchart", "flowchart LR\n  A --> B\n  note right of A: hi", /line 3/],
	["sequence message without colon", "sequenceDiagram\n  A->>B", /line 2/],
	["sequence message containing ;", "sequenceDiagram\n  A->>B: a; b", /line 2/],
	["sequence flowchart arrow", "sequenceDiagram\n  A --> B", /line 2/],
	["sequence participant named end", "sequenceDiagram\n  A->>end: hi", /unexpected 'end'/],
	["sequence unclosed loop", "sequenceDiagram\n  loop every s\n  A->>B: x", /end of input/],
	["sequence deactivate inactive participant", "sequenceDiagram\n  A->>B: x\n  deactivate B", /inactive participant/],
	["state -> arrow", "stateDiagram-v2\n  A -> B", /line 2/],
	["state id with hyphen", "stateDiagram-v2\n  [*] --> my-state", /line 2/],
	["state unclosed composite", "stateDiagram-v2\n  state Busy {\n    [*] --> Working", /end of input/],
	["class generic with <T>", "classDiagram\n  class List<T>", /line 2/],
	["class -> arrow", "classDiagram\n  A -> B", /line 2/],
	["class unclosed body", "classDiagram\n  class Duck {\n    +swim()", /line 3/],
	["er relationship without label", "erDiagram\n  CUSTOMER ||--o{ ORDER", /line 2/],
	["er non-crowfoot cardinality", "erDiagram\n  CUSTOMER 1--* ORDER : places", /line 2/],
	["er unquoted label containing a keyword (many)", "erDiagram\n  CUSTOMER ||--o{ ORDER : places many", /line 2/],
	["mindmap with two roots", "mindmap\n  root\n  other", /only one root/],
	["mindmap unquoted parentheses in [] node", "mindmap\n  root\n    a[Foo (bar)]", /line 3/],
	["empty source", "", /No diagram type detected/],
];

// Surprising but true in 11.13.0: these parse fine (and so render in Obsidian).
const SURPRISINGLY_VALID = [
	["stray closing fence after the diagram", "flowchart LR\n  A --> B\n```"],
	["label text 'end' inside brackets", "flowchart LR\n  A[end] --> B"],
	["node id default / o / xray", "flowchart LR\n  default --> o\n  A --- xray"],
	["hyphenated node ids", "flowchart LR\n  node-a --> node-b"],
	["tag comment before the type line", `${TAG}\nflowchart LR\n  A --> B`],
	["tag comment indented inside a mindmap", `mindmap\n  root\n    ${TAG}\n    a`],
	["er entity name with a space", "erDiagram\n  Customer Account ||--o{ ORDER : has"],
	["er unquoted multi-word label", "erDiagram\n  CUSTOMER ||--o{ ORDER : places orders"],
	["unquoted parentheses in a mindmap text node", "mindmap\n  root\n    Foo (bar)"],
	["parentheses and ; in state transition label", "stateDiagram-v2\n  A --> B : f(x); y"],
];

test("pins the Mermaid version Obsidian bundles", async () => {
	assert.equal(OBSIDIAN_MERMAID_VERSION, "11.13.0");
	const { createRequire } = await import("node:module");
	const pkg = createRequire(import.meta.url)("mermaid/package.json");
	assert.equal(pkg.version, OBSIDIAN_MERMAID_VERSION);
});

describe("validateMermaid: valid diagrams", () => {
	for (const [name, source, type] of VALID) {
		test(name, async () => {
			assert.deepEqual(await validateMermaid(source), { status: "valid", diagramType: type });
		});
		test(`${name} + tag line`, async () => {
			assert.deepEqual(await validateMermaid(withTag(source)), { status: "valid", diagramType: type });
		});
	}
	test("zoom and dependency-map tags are valid comments", async () => {
		for (const tag of ["%% system: CPU — zoom: ALU", "%% system: CPU - overview", "%% dependency-map"]) {
			const result = await validateMermaid(`flowchart TD\n${tag}\n  A --> B`);
			assert.equal(result.status, "valid", tag);
		}
	});
	for (const [name, source] of SURPRISINGLY_VALID) {
		test(`surprisingly valid: ${name}`, async () => {
			assert.equal((await validateMermaid(source)).status, "valid");
		});
	}
});

describe("validateMermaid: invalid diagrams (typical LLM mistakes)", () => {
	for (const [name, source, pattern] of INVALID) {
		test(name, async () => {
			const result = await validateMermaid(source);
			assert.equal(result.status, "invalid", JSON.stringify(result));
			assert.match(result.error, pattern);
			assert.ok(result.error.length <= 300, `error too long: ${result.error.length}`);
		});
	}
});

describe("validateMermaid: robustness", () => {
	test("never throws on non-string input", async () => {
		for (const input of [undefined, null, 42, {}]) {
			const result = await validateMermaid(input);
			assert.ok(["valid", "invalid", "unavailable"].includes(result.status));
		}
	});
	test("concurrent requests are serialised and each gets its own answer", async () => {
		const sources = Array.from({ length: 12 }, (_, i) => (i % 2 ? `flowchart LR\n  N${i} --> M${i}` : `flowchart LR\n  N${i}[x (${i})] --> M`));
		const results = await Promise.all(sources.map((s) => validateMermaid(s)));
		results.forEach((r, i) => assert.equal(r.status, i % 2 ? "valid" : "invalid", sources[i]));
	});
	test("results are cached by source", async () => {
		const source = "flowchart LR\n  Cache1 --> Cache2";
		const first = await validateMermaid(source);
		const started = performance.now();
		const second = await validateMermaid(source);
		assert.equal(second, first);
		assert.ok(performance.now() - started < 5);
	});
	test("no DOM globals on the main thread", () => {
		assert.equal(typeof globalThis.window, "undefined");
		assert.equal(typeof globalThis.document, "undefined");
		assert.equal(typeof globalThis.DOMParser, "undefined");
	});
});

describe("extractMermaidBlocks", () => {
	test("plain block with offsets", () => {
		const md = "Intro\n```mermaid\nflowchart LR\n  A --> B\n```\nAfter";
		const blocks = extractMermaidBlocks(md);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].source, "flowchart LR\n  A --> B");
		assert.equal(md.slice(blocks[0].start, blocks[0].end), "```mermaid\nflowchart LR\n  A --> B\n```");
	});
	test("callout-prefixed block (Obsidian > lines)", () => {
		const md = "> [!abstract] PI\n> Here:\n> ```mermaid\n> flowchart LR\n>   A --> B\n>\n> ```\n> done";
		const [block] = extractMermaidBlocks(md);
		assert.equal(block.source, "flowchart LR\n  A --> B\n");
		assert.equal(md.slice(block.start, block.end), "```mermaid\n> flowchart LR\n>   A --> B\n>\n> ```");
	});
	test("CRLF line endings", () => {
		const md = "a\r\n```mermaid\r\nflowchart LR\r\n  A-->B\r\n```\r\nb";
		const [block] = extractMermaidBlocks(md);
		assert.equal(block.source, "flowchart LR\n  A-->B");
		assert.equal(md.slice(block.start, block.end), "```mermaid\r\nflowchart LR\r\n  A-->B\r\n```");
	});
	test("two blocks, tildes, case-insensitive info string with trailing spaces, longer fences", () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```\ntext\n~~~~ Mermaid  \nsequenceDiagram\n  A->>B: hi\n~~~~~\n";
		const blocks = extractMermaidBlocks(md);
		assert.deepEqual(
			blocks.map((b) => b.source),
			["graph TD\n  A-->B", "sequenceDiagram\n  A->>B: hi"],
		);
		assert.equal(md.slice(blocks[1].start, blocks[1].end), "~~~~ Mermaid  \nsequenceDiagram\n  A->>B: hi\n~~~~~");
	});
	test("unterminated fence is ignored", () => {
		assert.deepEqual(extractMermaidBlocks("```mermaid\nflowchart LR\n  A-->B\n"), []);
		const md = "> ```mermaid\n> flowchart LR\nnot in callout\n```mermaid\ngraph TD\n  X-->Y\n```";
		assert.deepEqual(
			extractMermaidBlocks(md).map((b) => b.source),
			["graph TD\n  X-->Y"],
		);
	});
	test("ignores other languages, nested examples and short fences", () => {
		const md = "````markdown\n```mermaid\ngraph TD\n```\n````\n``mermaid\nx\n``\n```js\nconst a = 1;\n```\n```mermaidx\ngraph TD\n```";
		assert.deepEqual(extractMermaidBlocks(md), []);
	});
	test("closing fence must be at least as long as the opening one", () => {
		const md = "````mermaid\nflowchart LR\n```\n  A-->B\n````";
		assert.deepEqual(extractMermaidBlocks(md).map((b) => b.source), ["flowchart LR\n```\n  A-->B"]);
	});
});

describe("describeMermaid", () => {
	test("flowchart counts (labels, chains, fan-out, all edge kinds) and overview tag", () => {
		const shape = describeMermaid(
			[
				"flowchart LR",
				TAG,
				'  A["Fetch (PC)"] --> B{Decode?}',
				"  B -->|ok| C((Exec))",
				"  C -.-> A",
				"  B -- no --> D[(Mem)]",
				"  D ==> E",
				"  E --x F",
				"  F --o G",
				"  G --- H",
				"  A-->B-->C",
				"  I & J --> K",
			].join("\n"),
		);
		assert.deepEqual(shape, {
			diagramType: "flowchart",
			nodes: 11,
			edges: 12,
			tag: { kind: "system", label: "Fetch-decode-execute cycle", level: "overview" },
		});
	});
	test("graph normalises to flowchart; subgraph/classDef/style lines are not nodes", () => {
		assert.deepEqual(describeMermaid("graph TD;\n  A-->B;\n  B-->C;"), { diagramType: "flowchart", nodes: 3, edges: 2 });
		const shape = describeMermaid("flowchart TB\n  subgraph S[\"Sub (x)\"]\n    direction LR\n    A1 --> A2\n  end\n  classDef hot fill:#f00\n  class A1 hot\n  style A2 fill:#0f0\n  A2:::hot --> Z");
		assert.equal(shape.nodes, 3);
		assert.equal(shape.edges, 2);
	});
	test("sequenceDiagram: participants (incl. implicit) and all message arrows; zoom tag", () => {
		const shape = describeMermaid(
			"sequenceDiagram\n%% system: HTTP – zoom: TLS handshake\n  participant C as Client\n  actor U\n  U->>C: click\n  C->>+S: GET\n  S-->>-C: 200\n  C-)Q: async\n  C--)Q: async2\n  C--xS: cancel\n  C-xS: x\n  C->S: plain\n  C-->S: dotted\n  Note over C,S: hi\n  loop retry\n    C->>S: again\n  end",
		);
		assert.deepEqual(shape, {
			diagramType: "sequenceDiagram",
			nodes: 4,
			edges: 10,
			tag: { kind: "system", label: "HTTP", level: "zoom", subsystem: "TLS handshake" },
		});
	});
	test("stateDiagram-v2 counts states incl. [*] and transitions", () => {
		const shape = describeMermaid(
			"stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start\n  state Busy {\n    [*] --> Working\n    Working --> [*]\n  }\n  Busy --> [*]\n  state \"Long name\" as L\n  Idle --> L\n  note right of Idle\n    multi\n  end note",
		);
		assert.deepEqual(shape, { diagramType: "stateDiagram-v2", nodes: 5, edges: 6 });
	});
	test("classDiagram relations", () => {
		const shape = describeMermaid(
			"classDiagram\n  Animal <|-- Duck\n  Duck *-- Beak\n  Duck o-- Egg\n  Fish --> Water\n  Pond ..> Water\n  Duck ..|> Swimmer\n  Zoo -- Animal\n  class Duck {\n    +String beak\n  }\n  class Keeper\n  Customer \"1\" --> \"*\" Order : places",
		);
		assert.deepEqual(shape, { diagramType: "classDiagram", nodes: 12, edges: 8 });
	});
	test("erDiagram entities and relationships; dependency-map tag", () => {
		const shape = describeMermaid(
			"erDiagram\n%% dependency-map\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains\n  CUSTOMER }|..|{ DELIVERY-ADDRESS : uses\n  PRODUCT {\n    string name\n  }",
		);
		assert.deepEqual(shape, { diagramType: "erDiagram", nodes: 5, edges: 3, tag: { kind: "dependency-map" } });
	});
	test("mindmap: items are nodes, edges = nodes - 1", () => {
		assert.deepEqual(describeMermaid("mindmap\n  root((CPU))\n    ALU\n    Control\n      Decoder\n      ::icon(fa fa-book)\n    Registers"), {
			diagramType: "mindmap",
			nodes: 5,
			edges: 4,
		});
	});
	test("type line skips frontmatter, directives and comments; tag tolerates spaces and ASCII dash", () => {
		const shape = describeMermaid("---\ntitle: x\n---\n%%{init: {'theme':'dark'}}%%\n%% system:  Memory hierarchy  -  zoom:  L1 cache \nflowchart LR\n A-->B");
		assert.deepEqual(shape, {
			diagramType: "flowchart",
			nodes: 2,
			edges: 1,
			tag: { kind: "system", label: "Memory hierarchy", level: "zoom", subsystem: "L1 cache" },
		});
	});
	test("never throws", () => {
		for (const input of ["", "   \n", "garbage", undefined, null, 7, "flowchart LR\n  A[[[((({{"]) {
			const shape = describeMermaid(input);
			assert.equal(typeof shape.diagramType, "string");
			assert.equal(typeof shape.nodes, "number");
			assert.equal(typeof shape.edges, "number");
		}
		assert.equal(describeMermaid("").diagramType, "unknown");
	});
});
