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

## 2. `extensions/obsidian-link.ts` + `extensions/lib/learn-notes.ts` — Obsidian layer

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
- Commands: `/learn new <topic>` (or `/learn <topic>`), `/learn open [note]`, `/learn search [words]`,
  `/learn resume [note]`, `/learn status`, `/learn close`, `/learn obsidian [folder]`, `/learn help`.
  `/learn-resume [note]` remains a shortcut for older users. No separate note-logging commands are registered.
- Open, search and resume accept a picker with no argument. Argument completion filters note titles and paths;
  search includes ordinary Markdown notes in the selected folder. Resume builds context from note contents.
- Notes directory: `PI_LEARN_NOTES_DIR`, else `<agent-dir>/pi-learn.json` `notesDir`, else `ctx.cwd`.
  `/learn obsidian <vault>` saves `<vault>/Learn`. Index note: `<notesDir>/Learn Index.md`.
- New session metadata uses the `learn-link` custom entry. Legacy `md-log` entries are read so an existing Pi
  session can restore its linked note; new commands do not write them.
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

## 5. `extensions/commons-images.ts` — visual reference path

- The teaching plan identifies nodes that could benefit from an identifiable real view and states what to notice.
- `search_commons_images` requires a short concrete `query`, `needed_view`, and `learning_goal`.
  The last two complete: “The learner needs to see [needed_view] to understand or recognize [learning_goal].”
- The tutor inspects returned Commons previews. `import_commons_image` accepts only a candidate ID from a
  preview plus `what_to_notice` and descriptive `alt_text`. Images are optional when none fit.
- Imported files live under the vault's `pi-learn-images/` folder. The local Markdown embed, observation
  sentence, and creator/source/license attribution stay together in the linked note.
