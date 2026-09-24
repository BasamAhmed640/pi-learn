# Handoff — pi-learn

**Repo:** https://github.com/BasamAhmed640/pi-learn (fork of amosblomqvist/learn). The working copy is
`C:\Users\basam\Documents\pi-learn` on branch `feat/system-diagrams`.
Goals and acceptance criteria: [PLAN.md](PLAN.md). Interfaces: [CONTRACTS.md](CONTRACTS.md).

## 2026-09-24 release

- Pi Learn replaces the `/md-log` and `/md-unlog` command flow with `/learn new`, `/learn open`,
  `/learn search`, `/learn resume`, `/learn status`, `/learn close`, and `/learn obsidian`. Bare `/learn`
  displays the guide. Pi's completion list and a picker help find notes, including ordinary Markdown notes.
- A fresh resume still reconstructs context from the note, preserving its previous sections. Older session
  metadata is read for compatibility; new links use `learn-link` entries.
- The teaching plan identifies specific lesson points where a real image can help. Search requires a concrete
  view and learning goal. Import requires a previewed Commons candidate, a sentence on what to notice, and
  descriptive alt text; the local image is placed with attribution beside the explanation. A bounded visual
  review checks the preview against the original learning need, including after broader search retries. It
  rejects mismatched images and skips import when the review is unavailable.
- `npm test` passed **203/203** and the end-to-end UI self-test passed. A focused live check accepted a real
  BGA solder-ball image and rejected an Intel LGA photo for the same BGA learning need, without writing the
  rejected image. The longer BGA lesson exposed that error before the fix; it timed out during its first model
  turn, so it is not counted as a completed end-to-end run. Details are in [ACCEPTANCE.md](ACCEPTANCE.md).
- GitHub `main` and `feat/system-diagrams`, the personal Pi package, and the vault's `Learn` package have been
  updated from the same release. Pi's real loader found all six package extensions with zero errors from both
  the vault and the home directory. Restart Pi or use `/reload` in an already open session to pick up the new
  commands. The previous Silicon Packaging note was preserved.

## Prior release (2026-09-23)

### Done (verified at that release)
- `npm test`: **200/200 pass**. It covers unit tests and integration tests using pi 0.87.1's real extension loader.
- Teach skill: additive **Systems get a Mermaid diagram** rule, covering your definition, the 4-tier decision rule,
  diagram types, overview + zoom-ins, and Mermaid 11.13 syntax rules. Every question goes through
  `quiz`/`ask_user_question`, so it shows up as a callout.
- `extensions/system-diagrams.ts` does four things:
  - injects the policy into every run;
  - validates each diagram with mermaid **11.13.0** (the version Obsidian bundles) and asks for a repair up to 2×;
  - runs a semantic classifier that holds back a quiz until an undiagrammed system gets its diagram (at most
    1 nudge per message and 3 per run; fails open);
  - rejects disconnected mapping pictures and requests a bounded causal review before a quiz, hiding rejected
    diagrams in the note. Reviewer failures are recorded and fail open.
- `md-log`:
  - `/learn <topic>`, `/learn-resume [note]` and the `Learn Index.md` note;
  - per-session `## Session N (date)` sections and non-destructive re-linking;
  - properties, including `cssclasses: pi-learn`;
  - invalid diagrams are hidden behind a warning callout;
  - blocked quiz/ask calls never reach the note.
- Centering: `styles/pi-learn.css` is installed into `<vault>/.obsidian/snippets` and enabled once. A final
  20-note Obsidian run centered all 42 diagrams, 360 callouts and 35 display equations.
- Real reference images: `search_commons_images` shows licensed Wikimedia Commons previews;
  `import_commons_image` saves a chosen image in the vault and returns an embed plus attribution. A live Commons
  JPEG import rendered in Obsidian with no unresolved embed. Mermaid remains the system-diagram default.
- The GitHub package is installed in `C:\Users\basam\Desktop\Basam's_Vault\Learn`. Pi loads all six pi-learn
  extension entries with 0 errors, the two Commons tools are present, and pi-learn owns `quiz` and
  `ask_user_question`, with rpiv filtered out for this project. The CSS snippet is enabled in the real vault.
- Linked Obsidian lessons now receive an image policy in every model run: search at the first useful visual point,
  retry one broader concrete Commons query if needed, and import only a relevant, attributed reference image.
- Pi was also opened from `C:\Users\basam`, outside the project, so that session did not load the project package.
  A personal package install plus `<agent-dir>/pi-learn.json` now lets `/learn` work from any directory while
  keeping notes in the vault. The personal rpiv extension is filtered to avoid a duplicate question tool.
  Bare `/learn` and `/learn help` show a guide to the commands, skills and tools.
- Live learning sessions: the original ten-scenario batch passed 9/10 under its early stopping limit; a longer
  market run passed the remaining ambiguous topic. A later PID run confirmed that the model-backed system
  classifier and diagram reviewer run in practice. Full details: [ACCEPTANCE.md](ACCEPTANCE.md).

### Accuracy limit and first use
- **Diagram factual accuracy remains open (AC7).** The original notes contained causal mistakes despite valid
  Mermaid syntax. The new bounded reviewer caught structural examples in integration tests, but the live PID
  run reviewed only three of five diagrams and left a dimensional error in the note. Its failures do not stop a
  lesson. Review a diagram before relying on it for a high-stakes or technical claim.
- **Obsidian verified and restored:** the final full check passed 20/20 notes, centering 42/42 Mermaid diagrams,
  360/360 callouts and 35/35 display equations. A real-vault setup note passed diagram, callout and equation
  checks. Mermaid trust was enabled in `Basam's_Vault`; the temporary setup note was removed. Obsidian was
  closed, and `%APPDATA%\obsidian\obsidian.json` was restored to start with `Basam's_Vault` and without the
  verifier's temporary `"cli": true` setting.
- In `C:\Users\basam\Desktop\Basam's_Vault\Learn`, run `pi`, approve project trust once, then use
  `/learn <topic>`.

### Gotchas
- pi keeps the **first** registered tool of a given name, so `ask_user_question` needs the project-scoped rpiv filter.
- `ctx.newSession()` invalidates the old ctx. `/learn-resume` hands off through `newSession({ setup })` plus a global
  md-log hook.
- The Mermaid validator runs in a worker thread (linkedom + mermaid), so pi's main thread never gets DOM globals.
  The first check takes about 0.8 s; later ones take about 2 ms.
