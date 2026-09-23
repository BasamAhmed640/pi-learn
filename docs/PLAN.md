# pi-learn — plan, goals and acceptance criteria

Fork of [amosblomqvist/learn](https://github.com/amosblomqvist/learn). Amos's learning system is the baseline:
the `teach` skill (two principles; probe → plan → teach; the per-node loop motivate → establish → connect →
quiz-check), the `quiz` / `ask_user_question` question engine, and `md-log`'s live Obsidian mirror. It is kept
as-is except where the goals below require a change.

## Baseline findings

| Area | Baseline | Gap addressed |
|---|---|---|
| Explanation engine | `skills/teach/SKILL.md` | No notion of "system"; no default diagrams |
| Question engine | `quiz` (graded, shuffled, "I don't know", note) + `ask_user_question` | Kept unchanged |
| Obsidian | `md-log` mirrors the session; questions already render as `> [!question]` callouts | Re-linking overwrote the note; no resume from the note; no links between sessions/notes; blocked calls would log bogus answers |
| Mermaid | Only the Phase-2 dependency map; other visuals via a tmux/macOS-only PNG subagent whose rule is "when in doubt, don't" | Opposite of the requested default; unusable on Windows; no validation |
| Environment | pi 0.87.1 keeps the first registered tool per name; rpiv's global `ask_user_question` shadows the bundled one; Obsidian bundles mermaid 11.13.0 | Project-scoped install; validator pinned to 11.13.0 |

## Goals

- **G1 System detection** — semantic (structure, not keywords): 2+ of the nine structural features; four tiers (not / possibly / clearly / complex).
- **G2 Mermaid by default** — expected for clear systems, required for complex (overview + zoom-ins), strongly preferred for possible systems, absent for atomic concepts.
- **G3 Valid Mermaid** — every diagram parses with mermaid 11.13.0 (Obsidian's version); failures get a bounded repair loop and are never shown as error boxes.
- **G4 Useful diagrams** — components, flows, direction, inputs/outputs, sequencing, interfaces, feedback; no term lists.
- **G5 Questions in callouts** — every question goes through `quiz` / `ask_user_question` and lands in the note as a callout.
- **G6 Obsidian linking** — `/learn <topic>`, properties, per-session sections, non-destructive relinking, index note.
- **G7 Resume from Obsidian** — `/learn-resume` rebuilds the tutor's context from the note alone.
- **G8 Centered presentation** — callouts, display equations and Mermaid diagrams render centered in Obsidian (scoped CSS snippet).
- **G9 Baseline preserved** — teach text changes are additive; md-log block formats byte-identical.
- **G10 Ships** — GitHub fork `BasamAhmed640/pi-learn`, installed as a pi package in the vault's `Learn/` project.

## Workflow

1. Setup: fork, working copy, package manifest, shared contracts (`docs/CONTRACTS.md`).
2. Parallel build on disjoint files: Mermaid validator (A), Obsidian session layer (B), end-to-end harness (E),
   Amos's Obsidian workflow research (F), real-Obsidian render verifier (G), teaching policy + `system-diagrams`
   gate + centering CSS (lead).
3. Integrate; `npm test`.
4. End-to-end sessions with a real model and a simulated learner driving the real quiz UI: 4 clear systems,
   1 complex system, 2 ambiguous, 2 non-systems, 1 resume. Verify each note in the running Obsidian app.
5. Fix, push, install, document results in `docs/ACCEPTANCE.md`.

## Acceptance criteria

| # | Criterion | Pass bar |
|---|---|---|
| AC1 | `npm test` | 0 failures |
| AC2 | Every Mermaid block in generated notes parses with 11.13.0 and renders as SVG in Obsidian | 100% |
| AC3 | Clear-system sessions: ≥1 concept diagram (excluding the dependency map), unprompted | 4/4 |
| AC4 | Ambiguous sessions produce a diagram | 2/2 |
| AC5 | Non-system sessions: 0 concept diagrams | 2/2 |
| AC6 | Complex session: overview + ≥1 zoom-in | yes |
| AC7 | Concept diagrams have ≥3 nodes and ≥2 edges and pass a manual usefulness review | 100% |
| AC8 | Question callouts == executed quiz/ask calls; no answer leaks before answering | 100% |
| AC9 | Relinking is idempotent; earlier sessions are never lost | yes |
| AC10 | A fresh session with `/learn-resume` continues instead of restarting | yes |
| AC11 | Unresolved wikilinks/embeds in Obsidian | 0 |
| AC12 | Callouts, display math and Mermaid diagrams centered in Obsidian (±2 px) | 100% |
| AC13 | Package loads in the vault project with 0 errors, using pi-learn's `quiz`/`ask_user_question` | yes |
