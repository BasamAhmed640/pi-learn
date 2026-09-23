# Acceptance record (2026-09-23)

The live runs used pi 0.87.1 with `opencode-go/deepseek-v4.1-flash` and a simulated learner that operated the real `quiz` and `ask_user_question` UI. Notes were written to the separate `pi-learn-acceptance` Obsidian vault. This record distinguishes automated checks from the manual review of what the diagrams actually say.

## Results

| Criterion | Result | Evidence / limit |
| --- | --- | --- |
| AC1 tests | Pass | 198/198 after image import and diagram quality changes were integrated. |
| AC2 Mermaid syntax and render | Pass for original batch | 42/42 blocks rendered in Obsidian without Mermaid errors. The market extension produced 8 more blocks validated by Mermaid 11.13.0; those have not yet been checked in Obsidian. |
| AC3 clear systems | Pass | 4/4 produced a concept diagram without a diagram request from the learner. |
| AC4 possible systems | Pass with longer market run | Binary search produced a concept diagram. The first market run stopped at the harness's three quiz-check limit before the planned diagram node; a six-turn, eight-check run produced six concept diagrams. |
| AC5 non-systems | Pass | Both produced zero concept diagrams. Their phase-two dependency maps are lesson plans, not concept diagrams. |
| AC6 complex system | Pass for structure | The computer lesson produced memory overview and zoom diagrams. Its run stopped before the promised end-to-end I/O lesson, so topic coverage is incomplete. |
| AC7 diagram usefulness and correctness | Open | Every concept diagram met the automated node/edge threshold, but manual review found misleading causal details in CPU, PID, networking, glucose regulation, and memory diagrams. A bounded causal quality gate was added after these runs; its live effect is being checked separately. |
| AC8 question callouts | Pass | In the ten-scenario batch, every executed question had a matching question and answer callout, and no answer leaked before the learner answered. |
| AC9 relinking | Pass in integration tests | Re-linking keeps existing sessions and user text; repeat linking is idempotent. |
| AC10 fresh resume | Pass | The PID resume run continued from the note, referred to the prior lesson, and did not repeat the goal probe. |
| AC11 note links | Pass in original batch | Obsidian reported zero unresolved links or embeds. |
| AC12 centered presentation | Pass for Mermaid and callouts; math fix verified in targeted reruns | Original batch: 42/42 Mermaid diagrams and 360/360 callouts centered. It exposed a 6 px math offset in four notes. After CSS correction, targeted checks centered 18/18 equations in the 0.999… note, 3/3 in binary search, 7/7 in resume PID, and 5/5 in PID. A combined rerun had intermittent Obsidian CLI timeout/measurement failures, so a full clean rerun remains useful. |
| AC13 installed package | Pass | The real vault project loads all five pi-learn extensions with zero errors and owns `quiz` and `ask_user_question`. |

The new Commons image path was tested separately: a live search returned licensed previews, a selected JPEG was saved inside the acceptance vault, and Obsidian rendered the local embed with attribution and no unresolved link. The updated package still needs its final installation check after publishing.

## Manual review findings

- The CPU overview implies flags live in the general register file and does not show the memory-to-register load direction.
- Several PID diagrams were disconnected mapping pairs or omitted motor mixing contributions; the D term was drawn as a controller self-loop.
- A networking diagram drew a single link-layer frame between browser and remote server, and a TLS sequence omitted the handshake before the HTTP request.
- A type 1 diabetes diagram reversed the causal direction between beta-cell destruction and high blood glucose.
- The complex computer lesson treated disk as an automatic cache tier and had an inconsistent DRAM-to-cache fill path.

These are content failures despite valid Mermaid syntax. The new quality gate rejects disconnected one-edge mappings and asks a model to identify definite causal mistakes before the next quiz. It is bounded and fails open if the reviewer is unavailable, so diagrams still need occasional human review.

## Reproduce

The main batch is `tests/e2e/out/acceptance-20260923-a` (9/10 under its early stopping limit). The longer market run is `tests/e2e/out/acceptance-market-extended` (1/1). The Obsidian reports are under `tests/obsidian/out/acceptance-20260923-a`, `math-fix-0999`, and `math-fix-all`. These generated run folders are local and are not committed to GitHub.

Run `npm test`, `node tests/e2e/selftest.mjs`, then `node tests/e2e/run.mjs --scenario all --parallel 3 --run-id <id> --vault <acceptance-vault>`. The end-to-end runner now exits nonzero when its acceptance report fails or the requested scenarios are incomplete.
