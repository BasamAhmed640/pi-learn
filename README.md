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
  quiz back if the explanation it tests describes a system but has no diagram yet.
- **Obsidian sessions you can come back to.** `/learn <topic>` creates and links a note. Each pi session gets its own
  section in the note. Relinking never destroys content. A `Learn Index` note links every topic, and
  `/learn-resume` continues a lesson from the note alone.
- **Centered presentation.** A scoped CSS snippet centers callouts, display equations and Mermaid diagrams in
  reading view and live preview.

## Install (as a pi package, project-local)

The learning project is a folder inside your Obsidian vault, as in Amos's setup. Install the package there:

```bash
cd "<your vault>/Learn"
pi install -l git:github.com/BasamAhmed640/pi-learn
```

If another package already provides `ask_user_question` (for example `@juicesharp/rpiv-ask-user-question`), switch
its extension off for this project only. pi keeps the first tool registered under a name, and the bundled one shares
a UI lock with `quiz`. Add this to `Learn/.pi/settings.json` under `packages`:

```json
{ "source": "npm:@juicesharp/rpiv-ask-user-question", "extensions": [] }
```

Start `pi` in the `Learn` folder and approve project trust once. The original install still works too: clone this
repo as the project's `.pi` directory.

## Use

| Command | What it does |
|---|---|
| `/learn <topic>` | Creates `<topic>.md` in the project folder, links it, and starts the lesson. If the note exists, it resumes instead. |
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
