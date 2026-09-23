# Handoff — pi-learn (2026-09-23)

**Repo:** https://github.com/BasamAhmed640/pi-learn (fork of amosblomqvist/learn). The working copy is
`C:\Users\basam\Documents\pi-learn` on branch `feat/system-diagrams`; `main` was fast-forwarded to it.
Goals and acceptance criteria: [PLAN.md](PLAN.md). Interfaces: [CONTRACTS.md](CONTRACTS.md).

## Done (verified)
- `npm test`: **178/178 pass**. It covers unit tests, plus integration tests that run through pi 0.87.1's real extension loader.
- Teach skill: additive **Systems get a Mermaid diagram** rule, covering your definition, the 4-tier decision rule,
  diagram types, overview + zoom-ins, and Mermaid 11.13 syntax rules. Every question goes through
  `quiz`/`ask_user_question`, so it shows up as a callout.
- `extensions/system-diagrams.ts` does three things:
  - injects the policy into every run;
  - validates each diagram with mermaid **11.13.0** (the version Obsidian bundles) and asks for a repair up to 2×;
  - runs a semantic classifier that holds back a quiz until an undiagrammed system gets its diagram (at most
    1 nudge per message and 3 per run; fails open).
- `md-log`:
  - `/learn <topic>`, `/learn-resume [note]` and the `Learn Index.md` note;
  - per-session `## Session N (date)` sections and non-destructive re-linking;
  - properties, including `cssclasses: pi-learn`;
  - invalid diagrams are hidden behind a warning callout;
  - blocked quiz/ask calls never reach the note.
- Centering: `styles/pi-learn.css` is installed into `<vault>/.obsidian/snippets` and enabled once. Checked in the
  real Obsidian app: 4/4 diagrams, 6/6 callouts and 2/2 display equations centered.
- The project-local package load was smoke-tested: it loads with 0 errors, and `quiz`/`ask_user_question` come
  from pi-learn, with rpiv filtered out.

## Not finished yet
1. **Live end-to-end sessions.** The harness is in `tests/e2e/` (from the E agent, possibly still in progress).
   Run `node tests/e2e/run.mjs --scenario all`, then `node tests/e2e/analyze.mjs tests/e2e/out/<runId>`, then verify
   the notes with `node tests/obsidian/verify-render.mjs --vault pi-learn-acceptance --notes Learn --out <dir>`.
   Record AC2–AC8 and AC10 in `docs/ACCEPTANCE.md`.
2. **Install into the real vault.** Do both steps below, then start `pi` there and approve project trust once:
   - Run `cd "C:\Users\basam\Desktop\Basam's_Vault\Learn"` then `pi install -l git:github.com/BasamAhmed640/pi-learn`.
   - Add `{ "source": "npm:@juicesharp/rpiv-ask-user-question", "extensions": [] }` to that folder's
     `.pi/settings.json` `packages` list.
3. **Restore your Obsidian settings.** The verifier moved `"open": true` from `Basam's_Vault` to the
   `pi-learn-acceptance` vault in `%APPDATA%\obsidian\obsidian.json` (backup: `obsidian.json.bak-pi-learn`).
   Close Obsidian and move the flag back. `"cli": true` was also enabled, which is harmless and useful.
4. **Mermaid permission.** Obsidian 1.13 asks "Display Mermaid diagrams in this vault?" once per vault.
   Click **Allow** in `Basam's_Vault`, or diagrams show as that prompt.

## Gotchas
- pi keeps the **first** registered tool of a given name, so `ask_user_question` needs the project-scoped rpiv filter.
- `ctx.newSession()` invalidates the old ctx. `/learn-resume` hands off through `newSession({ setup })` plus a global
  md-log hook.
- The Mermaid validator runs in a worker thread (linkedom + mermaid), so pi's main thread never gets DOM globals.
  The first check takes about 0.8 s; later ones take about 2 ms.
