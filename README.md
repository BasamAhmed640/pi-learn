# pi-learn

A fork of Amos Blomqvist's [learn](https://github.com/amosblomqvist/learn): his AI learning system for
[pi](https://github.com/earendil-works/pi), shown in [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).
His teaching method is unchanged. It still uses the `teach` skill, the probe → plan → teach process, the
motivate → establish → connect → quiz-check loop, graded `quiz` questions, and the live Obsidian log.
This fork adds:

- **Systems get a Mermaid diagram by default.** When the concept being taught is a *system* (interacting parts whose
  relationships matter), the tutor draws it without being asked. It uses the Mermaid type that fits the structure:
  flowchart, sequence, state, class/ER or timeline. Complex systems get an overview plus zoom-ins. Atomic or purely
  definitional concepts get no diagram. The decision is based on structure, not on keywords
  (see [Systems get a Mermaid diagram](skills/teach/SKILL.md)).
- **Checks that make the default hold.** The rule is injected into every run. Every diagram is parsed with
  Mermaid 11.13.0, the version Obsidian bundles, and broken ones are sent back for a redraw. A semantic check holds a
  quiz back if the explanation it tests describes a system but has no diagram yet. A bounded quality check rejects
  disconnected mapping pictures and asks a model to flag definite causal errors before the next quiz. Reviewer
  failures fail open; see the manual findings in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
- **Obsidian sessions you can come back to.** `/learn <topic>` creates and links a note. Each pi session gets its own
  section in the note. Relinking never destroys content. A `Learn Index` note links every topic, and
  `/learn-resume` continues a lesson from the note alone.
- **Centered presentation.** A scoped CSS snippet centers callouts, display equations and Mermaid diagrams in
  reading view and live preview.
- **Real reference images when they help.** The tutor can search Wikimedia Commons, inspect small previews, and
  import a relevant raster image into the vault with source, artist and license attribution. Imported images are
  saved under the vault's `pi-learn-images/` folder and embedded locally, so the note keeps working offline.
  Systems still get Mermaid diagrams.

## Install

The learning project can be a folder inside your Obsidian vault, as in Amos's setup. Install the package there to load it only when Pi starts in that folder:

```bash
cd "<your vault>/Learn"
pi install -l git:github.com/BasamAhmed640/pi-learn
```

Pi must trust that project before loading its package. Use `/trust` in Pi to save the decision. A Pi session started in another directory will not see a project-local installation.

To use `/learn` from **any** Pi directory, install it personally as well:

```bash
pi install git:github.com/BasamAhmed640/pi-learn
```

Set the destination for lessons in `<agent-dir>/pi-learn.json` (`<agent-dir>` defaults to `~/.pi/agent`):

```json
{ "notesDir": "C:\\path\\to\\your\\ObsidianVault\\Learn" }
```

`PI_LEARN_NOTES_DIR` takes precedence if set. Without either setting, `/learn` writes in Pi's current directory. When both personal and project installations are present, Pi uses the project copy in that project.

If another package already provides `ask_user_question` (for example `@juicesharp/rpiv-ask-user-question`), switch
its extension off for this project only. pi keeps the first tool registered under a name, and the bundled one shares
a UI lock with `quiz`. Add this to `Learn/.pi/settings.json` under `packages`:

```json
{ "source": "npm:@juicesharp/rpiv-ask-user-question", "extensions": [] }
```

For a personal install outside the project, filter the personal rpiv extension in `<agent-dir>/settings.json` the same way. This keeps the package installed but avoids a duplicate `ask_user_question` registration error; pi-learn provides the question tool everywhere.

Start `pi` in the `Learn` folder and approve project trust once. The original install still works too: clone this
repo as the project's `.pi` directory.

## Use

| Command | What it does |
|---|---|
| `/learn` or `/learn help` | Shows a persistent guide to the commands, skills, tools and note location. |
| `/learn <topic>` | Creates `<topic>.md` in the configured notes folder, links it, and starts the lesson. If the note exists, it resumes instead. |
| `/learn-resume [note]` | Continues a lesson from its note: topic, plan, diagrams already drawn, quiz history, last exchanges. With no argument it picks the most recently studied note. |
| `/md-log <file>` / `/md-unlog` | Amos's original commands. Link an existing note (non-destructive now) or stop logging. |

Notes get properties (`learn-topic`, `learn-status`, `learn-sessions`, `cssclasses: pi-learn`, …). Each pi session
writes under `## Session N (date)`, and resumed sessions link back to the previous one. Questions and answers appear
as callouts.

## What's in it

- `skills/teach/`: the philosophy and the process, including the system → Mermaid rule
- `skills/visualize/`: maker-rendered PNG visuals (spatial/geometric), for when a tmux subagent runner is available
- `extensions/quiz.ts`, `extensions/ask-user-question.ts`: graded and ungraded questions (TUI popups)
- `extensions/md-log.ts`: the Obsidian log, plus `/learn`, `/learn-resume`, the index and styling install
- `extensions/system-diagrams.ts`: policy injection, Mermaid validation and repair, and the semantic system check
- `extensions/commons-images.ts`: Commons search, preview and bounded import for local Obsidian image embeds
- `extensions/lib/`: pure helpers (Mermaid parsing/validation, note format, policy text, Obsidian styling)
- `styles/pi-learn.css`: the Obsidian snippet (centered callouts, equations, diagrams)
- `extensions/visual-tools/`, `agents/`: Amos's maker subagents (need pi-interactive-subagents, which runs in tmux)

## Tests

```bash
npm install
npm test                                   # unit + integration, against the installed pi
node tests/e2e/run.mjs --scenario all      # live-model learning sessions with a simulated learner
node tests/obsidian/verify-render.mjs ...  # checks the notes inside the running Obsidian app
```

See [docs/PLAN.md](docs/PLAN.md) for the goals and acceptance criteria, and [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
for the results.

## Credit

The teaching system, the quiz and question tools, md-log and the maker agents are Amos Blomqvist's work
([amosblomqvist/learn](https://github.com/amosblomqvist/learn)). This fork builds on them.
