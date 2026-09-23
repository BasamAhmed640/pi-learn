// Scenario catalogue for the live-model end-to-end runs (tests/e2e/run.mjs).
//
// kind drives the acceptance criteria in analyze.mjs:
//   system          ≥1 concept diagram
//   complex-system  ≥2 concept diagrams, including an overview and a zoom
//   ambiguous       ≥1 concept diagram (the topic can be framed as a system)
//   non-system      0 concept diagrams (the dependency map is still expected)
//   resume          PID run for 3 turns, then a fresh session resumes the note

export const DEFAULTS = Object.freeze({
	p: 0.7, // probability the simulated learner answers a quiz correctly
	dontKnowRate: 0.1, // probability of choosing "I don't know" (taken out of the wrong-answer share)
	maxUserTurns: 6,
	maxQuizChecksAfterPlan: 3,
	timeoutMin: 12,
});

export const SCENARIOS = [
	{
		id: "sys-cpu",
		kind: "system",
		topic: "How a CPU executes a program (fetch–decode–execute)",
		goal: "I want to be able to trace, step by step, what the CPU does while it runs a few machine instructions.",
		p: 0.7,
	},
	{
		id: "sys-network",
		kind: "system",
		topic: "How data travels from my browser to a web server (the network stack)",
		goal: "I want a mental model of every layer my HTTP request passes through, so I can reason about where things go wrong.",
		p: 0.7,
	},
	{
		id: "sys-pid",
		kind: "system",
		topic: "How a PID controller keeps a quadcopter level",
		goal: "I want to understand what each of P, I and D does in the loop well enough to reason about tuning a quadcopter.",
		p: 0.6,
	},
	{
		id: "sys-glucose",
		kind: "system",
		topic: "How the body regulates blood glucose (insulin and glucagon)",
		goal: "I want to understand the feedback loop well enough to explain what goes wrong in diabetes.",
		p: 0.7,
	},
	{
		id: "complex-computer",
		kind: "complex-system",
		topic: "How a modern computer runs a program end to end: CPU, memory hierarchy and I/O",
		goal: "I want the big picture of how the parts cooperate, then enough detail on each part to see why caches and I/O matter for speed.",
		p: 0.7,
		maxUserTurns: 7,
	},
	{
		id: "amb-market",
		kind: "ambiguous",
		topic: "How prices get set in a market (supply and demand)",
		goal: "I want to understand why prices move when supply or demand changes, intuitively.",
		p: 0.7,
	},
	{
		id: "amb-binary-search",
		kind: "ambiguous",
		topic: "How binary search finds an item",
		goal: "I want to understand why it works and why it is so fast, well enough to write it myself.",
		p: 0.8,
	},
	{
		id: "nonsys-prime",
		kind: "non-system",
		topic: "What a prime number is",
		goal: "I want a solid intuition for what primes are and why they matter.",
		p: 0.8,
	},
	{
		id: "nonsys-0999",
		kind: "non-system",
		topic: "Why 0.999… equals 1",
		goal: "I want to actually be convinced, not just shown a trick.",
		p: 0.6,
	},
	{
		id: "resume-pid",
		kind: "resume",
		topic: "How a PID controller keeps a quadcopter level",
		goal: "I want to understand what each of P, I and D does in the loop well enough to reason about tuning a quadcopter.",
		p: 0.6,
		// phase A: the PID session, cut short; phase B: a fresh session resumes the note.
		phaseA: { maxUserTurns: 3 },
		phaseB: { maxUserTurns: 3 }, // /learn-resume + 2 more turns
	},
];

export const KINDS = ["system", "complex-system", "ambiguous", "non-system", "resume"];

/** Resolve `id | kind | all` (comma-separated allowed) to a list of scenarios with defaults applied. */
export function selectScenarios(selector) {
	const wanted = String(selector || "all")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const out = [];
	for (const w of wanted) {
		const matches =
			w === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.id === w || s.kind === w);
		if (matches.length === 0) {
			throw new Error(
				`Unknown scenario "${w}". Known ids: ${SCENARIOS.map((s) => s.id).join(", ")}; kinds: ${KINDS.join(", ")}; or "all".`,
			);
		}
		for (const m of matches) if (!out.some((o) => o.id === m.id)) out.push(m);
	}
	return out.map(withDefaults);
}

export function withDefaults(s) {
	return { ...DEFAULTS, ...s };
}

export function getScenario(id) {
	const s = SCENARIOS.find((x) => x.id === id);
	if (!s) throw new Error(`Unknown scenario id "${id}"`);
	return withDefaults(s);
}
