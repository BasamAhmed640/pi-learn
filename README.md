# pi-learn

A fork of Amos Blomqvist's [learn](https://github.com/amosblomqvist/learn): his AI learning system for
[pi](https://github.com/earendil-works/pi), shown in [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).
His teaching method remains: the `teach` skill, the probe → plan → teach process, the
motivate → establish → connect → quiz-check loop, and graded `quiz` questions.
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
- **Obsidian notes you can find and continue.** `/learn new <topic>` creates and links a note. `/learn open` and
  `/learn search` find existing notes in Pi with completion or a picker. `/learn resume` starts a fresh Pi session
  using the actual note contents. Each Pi session gets its own section, and `Learn Index.md` links the topics.
- **Centered presentation.** A scoped CSS snippet centers callouts, display equations and Mermaid diagrams in
  reading view and live preview.
- **Real reference images when they teach something visible.** During planning, the tutor identifies lesson points
  where a specific real view would help the learner recognize or understand a concept. Before each search it states
  what the learner needs to see and why. It previews Wikimedia Commons results and imports an image only when the
  subject is clear and accurate and the creator and license are usable. The note places the local image beside a
  sentence explaining what to notice and source attribution. The image remains available offline; systems still
  get Mermaid diagrams.

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

In Pi, run `/learn obsidian "<your vault>"` to select the vault's `Learn` folder. To select an existing folder
inside the vault, pass that folder instead. This saves the destination in `<agent-dir>/pi-learn.json`
(`<agent-dir>` defaults to `~/.pi/agent`):

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
| `/learn` or `/learn help` | Shows the commands, skills, tools and current note location. |
| `/learn new <topic>` | Creates and links `<topic>.md`, then starts teaching. `/learn <topic>` is a shortcut. An existing topic note is resumed. |
| `/learn open [note]` | Finds an existing Markdown note and links it to this Pi session. With no name, opens a picker. |
| `/learn search [words]` | Searches note titles and topics in the Pi terminal, then lets you select a match. |
| `/learn resume [note]` | Starts a fresh Pi session using the note's contents, including any saved plan, diagrams, quizzes and recent exchanges. With no name, opens a picker. |
| `/learn status` / `/learn close` | Shows the current link or unlinks the note. |
| `/learn obsidian [folder]` | Shows or sets the Obsidian notes folder. A vault root selects its `Learn` folder. |

Type `/learn open ` or `/learn resume ` and use Pi's completion list to narrow by note title. Search also includes
ordinary Markdown notes in the selected vault folder. `/learn-resume` remains a shortcut; with no name, it chooses
the most recently studied learning note.

Learning notes get properties (`learn-topic`, `learn-status`, `learn-sessions`, `cssclasses: pi-learn`, …). Each Pi
session writes under `## Session N (date)`; resumed sessions link back to the previous one. Questions and answers
appear as callouts. Existing note content remains in place.

## What's in it

- `skills/teach/`: the philosophy and the process, including the system → Mermaid rule
- `skills/visualize/`: maker-rendered PNG visuals (spatial/geometric), for when a tmux subagent runner is available
- `extensions/quiz.ts`, `extensions/ask-user-question.ts`: graded and ungraded questions (TUI popups)
- `extensions/obsidian-link.ts`: searchable Obsidian linking and note-based resume, the index and styling install
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

The teaching system, quiz and question tools, original note logging, and maker agents are Amos Blomqvist's work
([amosblomqvist/learn](https://github.com/amosblomqvist/learn)). This fork builds on them.
