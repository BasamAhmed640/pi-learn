# Module contracts (shared by every work package)

All `extensions/lib/*.ts` modules are pure TypeScript that Node can run with native type
stripping: erasable syntax only (no `enum`, no parameter properties, no namespaces),
explicit `.ts` extensions on relative imports, and **no imports from pi packages**.
That keeps them unit-testable with `node --test` and loadable by pi's jiti runtime.
`extensions/lib/` has no `index.ts`, so pi never loads it as an extension on its own.

## 1. `extensions/lib/mermaid.ts` — extraction and validation (WP-A)

```ts
export const OBSIDIAN_MERMAID_VERSION = "11.13.0"; // what Obsidian bundles on this machine

export interface MermaidBlock {
  source: string;   // the diagram source between the fences (no fences, trimmed of the final newline)
  start: number;    // char offset of the opening fence in the markdown
  end: number;      // char offset just past the closing fence
}
export function extractMermaidBlocks(markdown: string): MermaidBlock[];

export type MermaidValidation =
  | { status: "valid"; diagramType: string }
  | { status: "invalid"; error: string }       // real syntax error: ask for a repair
  | { status: "unavailable"; error: string };  // validator could not run: fail open

export async function validateMermaid(source: string): Promise<MermaidValidation>; // never throws

export interface MermaidTag { kind: "system" | "dependency-map"; label?: string; level?: "overview" | "zoom" }
export interface MermaidShape { diagramType: string; tag?: MermaidTag; nodes: number; edges: number }
export function describeMermaid(source: string): MermaidShape; // cheap static metrics, never throws
```

### Diagram tag convention (written by the tutor, parsed by `describeMermaid`)

A Mermaid comment on the line right after the diagram-type line. Invisible when rendered.

```
flowchart LR
%% system: Fetch-decode-execute cycle — overview
...
```

- `%% system: <name> — overview` — whole-system diagram
- `%% system: <name> — zoom: <subsystem>` — lower-level diagram of one part
- `%% dependency-map` — the Phase-2 teaching plan DAG (not a concept diagram)

## 2. `extensions/md-log.ts` + `extensions/lib/learn-notes.ts` — Obsidian layer (WP-B)

- Baseline callout formats stay byte-identical (`> [!quote] YOU`, `> [!abstract] PI`, `> [!question] Quiz|Question`,
  success/failure/question/example/warning answer callouts).
- Frontmatter keys owned by pi-learn: `learn-topic`, `learn-status`, `learn-created`, `learn-updated`,
  `learn-sessions` (list of `"YYYY-MM-DD HH:mm · <8-char session id>"`), plus `tags: [learn]` on notes it creates.
- Each pi session writes into its own section:
  `## Session N (YYYY-MM-DD)` then `%% learn-session: <sessionId> %%`.
  A resumed session's section adds `Continues [[#Session N-1 (YYYY-MM-DD)]].`
- Relinking is non-destructive: earlier content (other sessions, frontmatter, the learner's own notes) is never lost.
- Assistant text is validated with `validateMermaid` before it is written; an `invalid` block is replaced in the
  note by a `> [!warning]` callout with the original source hidden in a `%% ... %%` comment.
- QA `tool_result` events with `isError: true` or without `details.status` are ignored (blocked calls).
- Commands: `/learn <topic>`, `/learn-resume [note]`, `/md-log <file>`, `/md-unlog`.
- Notes directory: `process.env.PI_LEARN_NOTES_DIR` or `ctx.cwd`. Index note: `<notesDir>/Learn Index.md`.
- Shared state for other extensions: `globalThis.__piLearn = { linkedNote: string | null }`.

## 3. `extensions/system-diagrams.ts` — system detection and Mermaid enforcement (lead)

- Injects the system-diagram policy into the system prompt for every run.
- Validates Mermaid in each assistant message; requests at most 2 repairs per run.
- Semantic backstop: when a substantial explanation without a diagram is about to be quiz-checked (tool_call `quiz`)
  or ends the run, a nested model call classifies it (not / possibly / clearly / complex). For possibly and above,
  the quiz call is blocked once with instructions to add the diagram first (or one continuation is requested at
  settle). Bounded: at most 1 nudge per assistant message and 3 per run. Fails open on any error.

## 4. Tests

- `npm test` → `tests/run.mjs` runs `tests/unit/*.test.mjs` and `tests/integration/*.test.mjs` (node:test).
- `tests/e2e/` — live-model sessions with a simulated learner (WP-E). Run explicitly.
- `tests/obsidian/` — real-Obsidian render verification (WP-G). Run explicitly.
