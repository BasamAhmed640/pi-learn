# Obsidian render checks

`verify-render.mjs` checks how notes **actually render in the running Obsidian desktop app**
(reading view): Mermaid diagrams, callouts, links/embeds, frontmatter, math, the `pi-learn.css`
centering, plus screenshots. It drives Obsidian through Obsidian's own CLI (`Obsidian.com`,
Obsidian 1.12+; checked with 1.13.7, which bundles Mermaid 11.13.0). These checks need a running
Obsidian, so `tests/run.mjs` does not run them. Run them yourself.

```sh
node tests/obsidian/verify-render.mjs --vault pi-learn-acceptance --notes Learn/render-check.md --out out/obsidian
node tests/obsidian/verify-render.mjs --vault "C:\Users\basam\Documents\pi-learn-acceptance\pi-learn-acceptance" --notes Learn --out out/obsidian
```

| option | meaning |
| --- | --- |
| `--vault <name\|path>` | vault name (as `Obsidian.com vaults` lists it) or its folder |
| `--notes <a.md,b.md\|folder>` | paths relative to the vault; a folder means every `.md` below it |
| `--out <dir>` | save `<note>.png` (full page, scroll-stitched), `<note>.mermaid-<n>-<diagram\|error\|guarded>.png` (one crop per Mermaid block) and `report.json` |
| `--snippet <name>` | CSS snippet to enable when `<vault>/.obsidian/snippets/<name>.css` exists (default `pi-learn`, `none` to skip) |
| `--no-enable-snippet` | only report whether the snippet is on |
| `--trust-mermaid` | click Obsidian's per-vault Mermaid "Allow" (see below) |
| `--tolerance <px>` | centering tolerance (default 2) |
| `--settle <ms>` | max wait for rendering per note (default 10000) |
| `--json` | print the full report only |

It exits with **1** if any note has a problem, **2** on usage or connection errors, and **0**
otherwise. A problem is any of:
- a Mermaid error, guarded block or unrendered block
- an unresolved link or embed
- a `[[#heading]]` / `[[Note#heading]]` / `[[#^block]]` that doesn't exist
- frontmatter that doesn't parse
- a MathJax error
- a leaked `%%`
- fewer rendered callouts than the source has
- a mermaid svg, top-level callout or display equation more than the tolerance off the centre of
  its column (the reading column, or `.callout-content` for blocks inside a callout)
- the snippet not being enabled
- a dialog left open

You can run it any number of times against the same Obsidian instance. It reuses the current
main-window tab and re-renders the note each time (`previewMode.rerender(true)`), so edits on disk
are picked up. It never opens dialogs, closes any that appear during the check, and restores every
setting it changes except two:
- enabling the snippet, which updates `.obsidian/appearance.json`
- `--trust-mermaid`, which is saved in Obsidian's app localStorage

## Fixtures

- `fixtures/render-check.md` is the positive fixture. It has 4 valid diagrams: a flowchart with
  a subgraph and a back-edge, a sequenceDiagram, a stateDiagram-v2, and one inside a
  `[!question]` callout. It also has 1 invalid block (`A[Foo (bar)]`), six callout types, inline
  math, display math at top level and inside a callout, `[[#Some heading]]`, `[[Missing note]]`
  and `%% comment %%`. Expected: 4 rendered, 1 Mermaid error, 1 unresolved link, 6 callouts, 8
  math elements (2 display), everything centered.
- `fixtures/negative-check.md` has no `cssclasses`, so its Mermaid diagram is left-aligned. It
  also has a broken cross-note heading, a broken same-note heading and a missing embed. Expected:
  1 unresolved embed, 2 broken subpaths, and the mermaid svg reported as not centered.

To run them, copy the fixtures into `<vault>/Learn/` first.

## The acceptance vault

This is `C:\Users\basam\Documents\pi-learn-acceptance\pi-learn-acceptance` (vault name
`pi-learn-acceptance`, id `fb9aa237615f2a37` in `%APPDATA%\obsidian\obsidian.json`; the file was
backed up first as `obsidian.json.bak-pi-learn`). In this vault:
- `.obsidian/snippets/pi-learn.css` is a copy of `styles/pi-learn.css`
- Mermaid is trusted
- `Learn/` holds the fixtures

## What the Obsidian CLI can do (1.13.7)

- **Enable it.** Go to Settings → General → Advanced → *Command line interface*. Without the GUI,
  quit Obsidian (`tasklist | findstr /i obsidian` must print nothing), add `"cli": true` at the
  top level of `%APPDATA%\obsidian\obsidian.json`, then start Obsidian again. Until then every
  command answers "Command line interface is not enabled…". If Obsidian isn't running, it answers
  "unable to find Obsidian".
- **Run it.** `"%LOCALAPPDATA%\Programs\Obsidian\Obsidian.com" help` lists every command, and
  `help <command>` shows one. Values are `key=value`; quote values that contain spaces.
- **Target a vault.** Put `vault=<name>` as the **first** argument, e.g.
  `Obsidian.com vault=pi-learn-acceptance vault`. `vaults verbose` lists names and paths.
- **Open a file.** `Obsidian.com vault=X open path=Learn/note.md [newtab]` (or `file=<name>`,
  which resolves like a wikilink). It opens in the tab's current mode. The verifier switches to
  reading view with
  `leaf.setViewState({type:"markdown", state:{file, mode:"preview"}})`.
- **Run JavaScript.** `Obsidian.com vault=X eval code="app.vault.getName()"`.
  - Promises are awaited.
  - The value prints as `=> <value>`, with objects as pretty JSON.
  - A thrown error prints `Error: <message>` but still **exits 0**.
  - Console errors raised during the eval are printed first as `[error] …` lines.
  - `require` (Node), `app` and `require('electron').remote` (BrowserWindow / webContents,
    including `webContents.debugger` for CDP) all work.
  - The verifier passes its probe as `(0,eval)(require('fs').readFileSync(...))(...)`, with
    every argument base64-encoded, so CLI quoting and `\n` handling can't mangle it.
- **Read the DOM.** `dev:dom selector=<css> [all] [text] [inner] [attr=<name>] [css=<prop>] [total]`.
  Reading view is **virtualised**: sections far from the viewport are detached, so `dev:dom` and
  `document.querySelectorAll` miss them. The probe reads
  `leaf.view.previewMode.renderer.sections[].el`, which keeps every rendered section, attached
  or not.
- **Take screenshots.** `dev:screenshot path=<file.png>` captures the window. `dev:cdp
  method=<Domain.method> params=<json>` sends a raw Chrome DevTools Protocol command. Also useful:
  `dev:console [level=error]`, `dev:errors`, `dev:css selector=…`, `devtools`.
- **Look up links.** `unresolved verbose`, `links path=…`, `outline path=… format=json`,
  `properties path=… format=json`.

## Gotchas found while building this

- **Obsidian 1.13 guards Mermaid per vault.** In a vault where nobody has clicked *Allow*, every
  Mermaid block renders as `.mermaid-wrapper.is-guarded` with "Display Mermaid diagrams in this
  vault? Only allow if you trust this vault's contents. [Allow]". That's the state users see in
  a fresh vault. The choice is `app.saveLocalStorage("mermaid-vault-trust", true)` followed by
  `app.workspace.trigger("post-processor-change")`, and `--trust-mermaid` does exactly that. The
  verifier reports guarded blocks as a failure.
- **This is how a Mermaid error looks in Obsidian 1.13.7 (Mermaid 11.13.0).** You do not get
  Mermaid's "Syntax error in text" bomb SVG. The block becomes
  `<pre class="language-mermaid"><code class="language-mermaid is-loaded">`, and its text starts
  with `Error parsing Mermaid diagram!`, then a blank line, then `Parse error on line N:`, the
  caret excerpt, and `Expecting …, got '…'`. A console error with the parser `hash` is also
  logged. A valid diagram is `div.mermaid > svg[aria-roledescription=flowchart-v2|sequence|stateDiagram…]`.
  The probe counts both forms, and also error SVGs (`aria-roledescription="error"`) in case a
  render-stage error ever produces one.
- **A Mermaid block inside a callout renders normally** (every line prefixed with `> `). It ends
  up inside `.callout-content`.
- **Occluded or minimized windows.** If the Obsidian window is covered or minimized, the page is
  `hidden`:
  - `requestAnimationFrame` stops, so reading view stops attaching sections on scroll.
  - `webContents.capturePage()` returns a **stale** frame.
  
  The probe switches `webContents.setBackgroundThrottling(false)` on for its duration and
  captures with CDP `Page.captureScreenshot` (fresh frame), so screenshots are right even when
  the window is minimized.
- The metadata cache is the source of truth for links. `[[#Heading]]` never shows up in
  `metadataCache.unresolvedLinks` (it resolves to the note itself), so headings are checked
  against `getFileCache(target).headings`.
- Obsidian opens every vault flagged `"open": true` in `obsidian.json` at startup. To avoid
  opening (and writing `workspace.json` into) the user's real vault, that flag was moved to the
  acceptance vault while Obsidian was closed.
