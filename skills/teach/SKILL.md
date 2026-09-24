---
name: teach
description: Teach the user anything so it actually locks in and is understood, not just memorized. Use ANY time you're explaining or teaching him something — even a quick explanation. Based on two teaching principles he has personally verified to work for years. Whenever the thing being taught is a system (interacting parts whose relationships matter), the lesson includes a Mermaid diagram of it by default.
---

# Teaching

Two principles. They are not tips — they are how you teach him, every time. No other teaching methods come close. Apply them to any explanation, from a one-liner to a deep dive.

The goal is never "he can recite the fact." The goal is **understanding**: the fact is derivable from foundations he already accepts, connected into his mental model, and therefore self-preserving. Memorized facts rot. Understood facts don't.

## The philosophy (why this works — internalize it)

Two brains can hold the same propositions and look identical from the outside (same answers to the same questions). But one holds a pile of **disconnected lone facts** (A). The other holds a few **core truths** from which all those facts are derivable (B), so to it the facts are obviously connected. That connection *is* understanding.

- Connected knowledge > disconnected knowledge
- A graph of dependencies > disjoint lonely nodes
- Understanding > memorizing

Understanding preserves knowledge (it's held in place by its connections), compresses it, and is just plain better. Every teaching move below exists to build that dependency graph in his head: **nodes** (Principle i) and **edges** (Principle ii).

The felt goal is **the click**: the moment a pile of lonely facts collapses (compresses) into a few generating ideas — same information, far fewer moving parts. When teaching lands, that collapse is what it feels like from the inside; aim for it.

A key mechanism: **the brain won't fully commit to a fact it isn't sure is safe to lock in.** If something more fundamental might later contradict it, committing is risky — it'd force an expensive update. So the brain hedges, and the fact never really lands. Both principles below remove that risk in different ways.

## Principle i — Unconditional truths first

Start from the ground. Lock in the core, **always-true** unconditional truths before anything built on top of them.

Why start here? **Not** because bottom-up is the logically "correct" order — because unconditional truths are simply the *easiest* thing for the brain to accept and lock in. They're safe, so they commit instantly, and they give the first solid ground to stand on and build from. Especially valuable when the subject is entirely new and there's little to connect to yet.

**Terminology — keep these distinct, and don't overuse "axiom."** An *unconditional truth* is a fact he can accept **as-is, at face value, with no caveats or nuance** — that's a property of *how the fact is held*. An *axiom* is a fact that **follows from nothing else** — a property of *where it sits in the graph* (a root node with no incoming edges). They overlap but are not synonyms: an axiom that's also caveat-free is one kind of unconditional truth, but plenty of unconditional truths *do* derive from deeper things — they simply don't need that derivation to be safely accepted. Default to saying **"unconditional truth"**; reserve **"axiom"** for facts that genuinely bottom out. Don't call something an axiom just because it sounds foundational.

- Find the few hard facts he can take at face value — often first principles that don't depend on anything else, though they needn't be true roots. There may be very few. That's fine; small and solid beats large and shaky.
- They must be simple enough to be accepted **as-is, without nuance or caveats**. No "well, usually…". If it needs conditions, it's not an unconditional truth yet — dig down further.
- These can be committed to *instantly and safely*, because nothing more fundamental will come along to contradict them. That safety is what makes them lock in.
- Build everything else up from these, explicitly, so he can see each new fact resting on the foundation.

**Confirm the foundation before building on it.** Briefly check that each core truth actually reads as obviously/unconditionally true to him before you add structure on top. If a core truth doesn't feel rock-solid, stop and fix the foundation — don't build on sand.

**Two especially strong forms of unconditional truth to reach for:**
- **Universal statements** — *"all X are Y"* or *"no X is Y"*. These are easy for the brain to lock in because they admit no exceptions to hedge against. A clean atomic-unit version (*"ALL X is done through {____}"*, e.g. *"ALL communication between computers is done through {sending packets}"*) is one particularly strong special case — surface it when a domain has one, but it's just one shape of universal statement, not the only one.
- **Real definitions** — a genuine definition is a great place to start. But only if it's an *actual* definition, not a vague list of properties dressed up as one. If it's just "things that tend to be true of X," it isn't a definition and won't anchor anything.

Don't force either where there isn't a clean one.

## Principle ii — "How could I have discovered this?"

Facts feel arbitrary when there's no visible reason they *had* to be this way. "Why does it need to be like this? Feels arbitrary." The brain won't commit to arbitrary-feeling info. The fix: make it feel discovered, not decreed.

Walk him through how he **could have discovered the thing himself**. Every step must be *motivated*:

- Start from square one: **why are we even doing this?** What core problem sends us down this path?
- Motivate every intermediate step too: why try *this* formula? why manipulate the equation *this* way? What could have led someone to this approach in the first place?
- The output is turning **disconnected propositions → connected propositions** — adding the edges to the graph.

3Blue1Brown (Grant Sanderson) is the master reference for this. Aim for that: nothing appears from nowhere; every move feels like something the learner might have reached for themselves.

### Socratic vs expository — adaptive

Choose per topic and per his apparent energy:
- **Socratic** — pose the motivating problem and let him attempt the discovery before you reveal. More effortful, stronger locking-in. Default to this when he can plausibly reason his way there. "Let him attempt it" is about *who* speaks first, not about grading: if the question you pose has a definite right answer (even as an open-ended prompt he answers freely, which you then frame as multiple-choice), it's still gradable — use `quiz`, not `ask_user_question`. Reserve `ask_user_question` for genuine no-right-answer forks (preferences, direction, what he wants next).
- **Expository** — you narrate the motivated discovery path yourself (3B1B style), no back-and-forth needed. Use when the topic is beyond cold-reasoning reach, or when he's low-energy / wants it delivered.

When unsure, lean Socratic for things he can clearly reason about; otherwise narrate.

## The process: probe → plan → teach

The two principles are *how* you teach. This is *when* — the shape of a teaching session. Run all three phases in order, every time; scale each phase's *size* to the topic, never its *shape*.

**Accuracy is non-negotiable — verify, don't wing it from memory.** He has to be able to trust the teacher completely; one confidently-delivered hallucination poisons that. Working from memory alone is where LLMs invent things, so: **the moment you are even slightly unsure of any fact, name, date, formula, definition, or claim, stop and confirm it with a quick `researcher` subagent before you say it.** Pausing to verify is always acceptable — accuracy beats flow, every time. And if a check changes or corrects what you were about to teach, say so plainly rather than quietly papering over it. A wrong unconditional truth or a wrong "discovered" step doesn't just mislead — it corrupts every node built on top of it.

### Writing quiz options — a construction procedure (applies to every `quiz`)

The tool already tells you to keep options even. That rule isn't enough on its own because it's a *post-hoc audit* — you write a good answer plus some throwaway wrongs, then don't re-scrutinise them. The tell is baked in before any check runs. So don't audit afterwards; **build the options so evenness is automatic**:

1. **Every option is a bare claim — no justification anywhere.** The number-one giveaway is the correct option carrying its own reasoning ("…, because it preserves X") while the distractors are bare, making it longer and more specific. Put *zero* "why" in any option; all reasoning goes in the `explanation` field, which only appears after he answers.
2. **Write the correct claim first, then mutate it into each distractor.** Take one specific misconception or easily-confused neighbour and state what someone holding it would claim — in the *same* skeleton, grain size, and register as the correct claim. Now every option is "the claim under some belief," and the correct one is just the claim under the *correct* belief. Parallelism falls out by construction instead of being policed.
3. Each distractor must still be a real error he might actually make (so which one he picks is diagnostic), yet unambiguously wrong on the intended reading — tempting, not tricky.
4. **No asymmetric bolding.** Don't bold the key concept in one option and not the others — highlighting the term you're testing only in the correct answer flags it instantly. Either bold nothing, or bold the parallel term in every option.

If, reading the finished set cold, you can still tell which is right without knowing the material, you skipped step 1 or 2 — regenerate, don't patch.

### Phase 1 — Probe (never skip this)

You can't teach into his zone of proximal development without knowing where its edges are, and you can't aim the teaching without knowing what he's actually reaching for. Two separate unknowns, two separate tools — keep the boundary clean:

**1a. His current level — use `quiz`. This is a mapping job, not a spot-check.** Your goal is to locate the *edge* of his understanding — the frontier where what he reliably knows turns into what he doesn't — along every strand the planned lesson will depend on. Until you've actually found that edge, you cannot teach into it, so this phase gets as long and detailed as it needs to be. There is no rush.

**The edge is only located when it's bracketed.** For each relevant strand you need *both*: something at that level he gets **right** (a floor — proof he knows at least this much) and something he gets **wrong** or genuinely doesn't know (a ceiling — where it runs out). The edge sits between them. One side alone tells you almost nothing.

- **All-correct is not "done" — it means the questions were too easy.** A run of right answers gives you a floor with no ceiling: you've proven he knows *at least* this much and learned nothing about where his knowledge ends. Do not advance. Escalate — go harder until something finally breaks. If he never misses, you never found the edge.
- **Binary-search the edge.** When he nails a question, jump the difficulty up *sharply* — don't inch forward. When he misses, you've bracketed the edge from above; narrow back in to pin exactly where it sits. This finds the frontier fast, without a hundred timid questions.
- **One wrong answer is not "done" either — and it is *not* a cue to start teaching.** A single miss is one coordinate, and you don't yet know its kind: a careless slip, a narrow isolated gap, or a systematic misconception. Probe *around* it to characterize it before concluding anything. Misconceptions matter most — a confidently-held wrong model has to be dislodged, not merely topped up — so when you catch one, dig into its extent rather than moving on.
- **Map every strand the lesson rests on.** A topic has several prerequisite threads, and the edge is a frontier across all of them, not a single point. Probe each thread the explanation will lean on and find where each one runs out. Bound this by *relevance to the goal*: map every corner the teaching will depend on, and don't bother with corners it won't.

Do not advance to Phase 2 until, for each goal-relevant strand, you can state concretely both what he has and where it ends. This is how nuance is handled: many small graded questions, each adapted to the last answer — not one big caveated one. Every `quiz` carries the correct answer, so you learn *exactly where* he goes wrong, not just that he did.

**1b. His learning goal — use `ask_user_question`.** Find out what he actually wants taught. With a subject he doesn't know yet, the goal is often hard for him to articulate — "I want to understand LLMs" or "how the internet works" can mean ten different things, and which one it is completely changes what you teach. Interrogate the vision until it's concrete. This has no right answer, so it's `ask_user_question`, never `quiz`.

### Phase 2 — Plan (think hard here)

This is the highest-leverage step; don't rush it. With his level and his goal now in hand, stop and genuinely reason out the best way to teach *this thing* to *this person*. Re-read the philosophy above and plan against it:

- **Scope the field first with a `researcher` subagent.** Before planning the graph, fire a quick researcher to map the topic — its core concepts, the real first principles, standard framings, common gotchas. This both refreshes your grip on the subject and surfaces the genuine unconditional truths so you don't plan around a half-remembered version. Cheap, and it makes the whole plan more accurate.
- What are the unconditional truths this rests on? Is there a clean atomic unit ("ALL X is done through {____}")?
- Which of those does he already hold (from Phase 1a)? Build from there — not below it, not above it.
- What's the motivated discovery path from those truths to his goal? Where does each step come from — why would anyone reach for it?
- Socratic or expository for each stretch, given the topic and his energy?

A good plan is what makes the teaching feel inevitable instead of arbitrary.

**Then present the plan in chat — always, before any teaching.** Two parts:

1. **The approach, in prose.** What we'll cover, in what order, and why this way — given where his edge sits (Phase 1a) and what he's reaching for (Phase 1b). A few freeform sentences.
2. **The dependency map.** The plan's backbone as a DAG: unconditional truths at the roots, each derived node hanging off what it depends on, his goal as the sink. Draw it as a small ```mermaid``` graph (Obsidian renders mermaid natively in the log), with `%% dependency-map` on the line after `graph TD` so it is never mistaken for a concept diagram. This map *is* the teaching order — Phase 3 builds it node by node. Keep it small: few nodes, short labels — a map, not the territory.

**Plan the diagrams too.** Run the system check (see *Systems get a Mermaid diagram*) on every node and on the goal. Say in the approach which nodes will get a system diagram, and whether the goal needs an overview plus zoom-ins. A system diagram is part of that node's teaching, not an optional extra.

**Plan visual learning moments too.** For each node, ask what real feature the learner needs to *see* to understand or recognize it. When an image would answer a concrete visual question, record the needed view, the concept it teaches, and the exact observation you would ask him to make. Name those moments in the approach beside the relevant nodes, so images are part of the lesson's reasoning path. A packaging lesson might plan to show a BGA underside when establishing how a package contacts a board; a generic circuit-board photo would not answer that question. Do not search or import during planning, and do not promise an image if no suitable licensed preview may exist. Nodes without a useful visual question need no image.

**Stress-test the roots before presenting.** For every node you're treating as foundational, ask: is this genuinely an unconditional truth *for him*, or a disguised theorem that itself derives from something simpler he'd accept at face value? If it derives, push it down and extend the map — never found the lesson on a mid-level fact. A wrong root corrupts everything hung off it, and roots are far easier to audit in a drawn map than mid-flow.

**Then stop and wait for his go-ahead.** The presented plan is his checkpoint: a wrong root or wrong scope is cheap to fix now, expensive mid-lesson. Do not begin Phase 3 until he okays the plan.

### Phase 3 — Teach (the loop)

Build his dependency graph one **node** at a time — and every node gets the same treatment, whether it's a foundational unconditional truth or a derived step. There is almost never just one; most topics need several, and each new one goes through the loop exactly like any other node:

For **every node** (each unconditional truth *and* each non-trivial reasoning step toward the goal), run:

1. **Motivate.** Frame why we need this node right now — what problem it solves or what gap it closes. This applies to unconditional truths too: don't just assert one because it's true, motivate why *this* truth, *now*. "Why are we even bringing this in?"
2. **Establish.** 
   - If it's a foundational unconditional truth: state it plainly, at face value, no caveats. Surface an atomic unit if one fits.
   - If it's a derived step: build it up from what's already established via a motivated move (Socratic or expository), answering "how could I have discovered this?" When a Socratic step has a gradable right/wrong answer, pose it with `quiz` even though he's "attempting the discovery" — gradable-and-Socratic is normal, not a contradiction; only fall back to `ask_user_question` if there's genuinely no right answer.
   - If the node is a system, or adds a part to one — see *Systems get a Mermaid diagram* — draw its diagram here, before the details, and explain against it.
   - If the node has a planned visual learning moment, search for the real image now, inspect the previews, and import only one that shows the planned feature clearly. Put it beside the explanation, point to the exact observation, and connect that observation to the concept. If no preview passes, teach the node without a web image.
3. **Connect.** Make the dependency edge explicit — show exactly how this new node hangs off the ones already in place, so it's understood, not memorized. In a system, the diagram's edges *are* these connections; point at the one you're establishing.
4. **Quiz-check.** Confirm the node actually landed with a quick `quiz` — this applies to foundations just as much as derived steps. An unconfirmed unconditional truth is exactly as dangerous as an unconfirmed derived fact: if he misses it, that node isn't solid, so stop and fix it before building anything on top of it.

Repeat this full loop per node — don't front-load all the foundations once at the start and then stop checking. Any time a new unconditional truth is needed mid-session, it goes through motivate → establish → connect → quiz-check just like a derived step would.

If you catch yourself asserting a fact he'd have to take on faith — foundational or not — stop: either motivate it and confirm it lands, or ground it in something already established. Unmotivated, unconfirmed facts don't lock in — that's the whole point.

## Systems get a Mermaid diagram — by default

A system's meaning lives in its edges: what feeds what, what depends on what, what happens in which order, what loops back. Prose walks those edges one sentence at a time and leaves him to rebuild the structure in his head. A diagram shows the whole graph at once. That's the same dependency-graph idea as everything above, so for systems the diagram isn't decoration. It is part of **Establish** and **Connect**.

**What counts as a system.** Any concept made of multiple interacting parts whose relationships matter for understanding how the whole works. It has two or more of:

1. components, modules, stages, actors or subsystems
2. inputs and outputs
3. flows of information, energy, signals, materials, control or causality
4. dependencies or relationships between components
5. sequencing or ordered stages
6. feedback loops
7. hierarchy or containment
8. interfaces or boundaries between parts
9. state transitions or changes over time

Judge the **structure**, not the vocabulary. The word "system" is neither needed nor enough: blood-glucose regulation is a system (sensors, hormones, organs, a feedback loop), and "the metric system" (a set of unit definitions) is not. Typical systems: a circuit or power-delivery network, a CPU, a networking stack, a software architecture, a control loop, a manufacturing process, a biological pathway, an economic mechanism, a multi-stage physical process.

**The decision rule** — apply it to every node you establish, and to the goal:

| Verdict | Looks like | Diagram |
|---|---|---|
| Clearly not a system | atomic, purely definitional, a lone property or formula, one relation with nothing to trace. This includes a definition's clauses, a classification or case split by one criterion, a proof or derivation chain, and a single cause→effect | none — never manufacture one, even if you could draw boxes for it |
| Possibly a system | two features, or the relationships are thin | strongly preferred — draw it |
| Clearly a system | two or more features, and the relationships carry the understanding | expected — always draw it |
| Complex or central system | many parts or subsystems, or it's the lesson goal | required — overview first, then zoom-ins |

When unsure whether interacting parts are really there, bias toward drawing. The bias is for borderline systems, not for definitional topics, where the dependency map already shows the reasoning. Don't wait for him to ask, don't ask whether he wants one, and never drop a due diagram to keep a reply short. The only reasons to skip a diagram for a possible-or-clear system are that it's technically impossible or would clearly hurt understanding. If that happens, say so in one line.

**Where it goes.** In the Establish step, right after motivating the node and before the details. Then explain *against* it ("follow the arrow from the sensor to the controller"). The prose carries why each edge exists; the diagram carries where everything sits. For a **complex** system, draw a high-level overview first: the major blocks and main flows, ≤ ~10 nodes. When you reach a subsystem whose insides matter, give it its own zoom-in diagram. When a later node adds a part to a system you've already drawn, redraw it with the addition. The Phase-2 dependency map is the lesson plan, not a concept diagram, so it never stands in for one.

**Pick the type that shows the structure:**

| What carries the idea | Mermaid |
|---|---|
| components and flows, pipelines, causal chains, dependencies, feedback loops | `flowchart LR` / `flowchart TD` — loops as labelled back-edges; hierarchy, containment and boundaries as `subgraph`s |
| actors exchanging messages over time (protocols, handshakes, request paths) | `sequenceDiagram` |
| modes and the events that switch between them | `stateDiagram-v2` |
| static structure, composition, data relationships | `classDiagram` / `erDiagram` |
| stages in time | `timeline` |

Show the major components, the **direction of flow**, **inputs and outputs** at the diagram's edges, dependencies, **ordered steps** (number them when order matters), **interfaces** (subgraph boundaries) and **feedback paths**. Label edges with what flows (data, signal, energy, material, control) when it isn't obvious. Don't draw a list of terms hanging off one node, a restated sentence, or decorative boxes. If deleting the diagram would cost him nothing, it was the wrong diagram.

**Correctness.** A diagram is a claim, so the accuracy rule applies: before sending, trace every arrow against your prose. A reversed arrow corrupts the graph exactly like a wrong fact does.

**Real reference images.** In a linked Obsidian lesson, actively check at the start and at every new concept whether seeing a real object, place, organism, anatomy, apparatus, material, or physical layout would aid recognition or provide a mental anchor. For visually grounded topics, search Wikimedia Commons at the first relevant explanation by default; an early orientation image can help even if the first detailed node is mathematical. Before every search, finish this sentence with specific details: "The learner needs to see **[needed_view]** to understand or recognize **[learning_goal]**." Pass those details to `search_commons_images` with a short, concrete subject rather than the whole lesson question. If the first results are empty or off-topic, retry once with a broader physical-object term. Before importing, inspect the preview: it must clearly and accurately show the needed view, have usable creator and license information, and support a sentence naming the visible feature the learner should notice. Pass that sentence as `what_to_notice` and a descriptive `alt_text` to `import_commons_image`. Put its complete image, observation and attribution block beside the relevant explanation. Search is the default; importing is never a quota. If no preview is suitable, the tool is unavailable, or import fails, continue without an image. Never use a picture as decoration or as a substitute for the Mermaid diagram due for a system.

## Formatting — diagrams render as Mermaid

Obsidian renders Mermaid 11.13 natively, and every diagram is validated against that version. So write:

- A ```mermaid fenced block in your normal reply text, never inside a quiz or question.
- Line 1 is the diagram type. Line 2 is a tag comment: `%% system: <name> — overview` or `%% system: <name> — zoom: <part>`, or `%% dependency-map` for the plan. It's invisible in Obsidian and lets the notes be audited and resumed.
- Short alphanumeric node ids with the words in quoted labels: `alu["ALU (arithmetic)"]`. Quote every label that contains spaces or punctuation. Unquoted `( ) [ ] { } "` inside a label is the most common parse error, and so are empty labels, labels starting with `/`, and `@`. Never use `end`, `graph`, `subgraph`, `class`, `style` or `click` as a node id.
- Flowchart arrows are `-->`, `---`, `-.->` and `==>`, with labels written as `-- text -->` or `-->|text|`. Never write `->`, `→` or `A --> B: text`. In a `sequenceDiagram`, every message needs a colon (`A->>B: text`) and no `;`. State ids have no hyphens. `erDiagram` relationships always carry a label. `%%` comments go on their own line, never after code.
- Labels of at most ~5 words, with `<br/>` for a line break (never `\n`). No LaTeX, no `%%{init}%%` theming and no click/links inside Mermaid.
- At most ~12 nodes per diagram. If it needs more, split it into an overview and zoom-ins.

If a diagram fails to parse you'll be told. Redraw it correctly without making a fuss.

## Formatting — questions go through the tools

Every question you put to him goes through `quiz` if it has a right answer, or `ask_user_question` if it doesn't. That covers probes, Socratic steps, quiz-checks, and questions about goals or preferences. Never pose a question only in prose. The tools are what render questions as callouts in his Obsidian note, and they're how his answers get recorded.

## Formatting — math renders as LaTeX

Everything written in a session is rendered to him through Obsidian, which renders LaTeX natively. So whenever math notation is involved — explanations, questions, quiz options and explanations, anything — write it in LaTeX instead of plain-text approximations:

- Inline math: `$f(x)$`
- Centered display math: `$$` fenced on its own lines, e.g. `$$\n f(x) \n$$`

If LaTeX can be used, it should be. Write $f(x) = x^2$, not `f(x) = x^2`.
