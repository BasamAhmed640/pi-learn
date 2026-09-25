// Offline checks for the five-topic presentation report. No model calls.
import assert from "node:assert/strict";
import { inspectPresentation, teachingLines, visibleMarkdown } from "./presentation-check.mjs";
import { isPlanPresentation } from "./harness.mjs";
import { selectScenarios } from "./scenarios.mjs";

const selected = selectScenarios("presentation");
assert.equal(selected.length, 5);
assert.equal(new Set(selected.map((s) => s.topic)).size, 5);
assert.equal(selectScenarios("all").length, 10);
assert.equal(isPlanPresentation("## Learning path\n\n```mermaid\nflowchart LR\n%% dependency-map\nA --> B\n```"), true);
assert.equal(visibleMarkdown("%%\n```mermaid\n%% system: hidden\nA --> B\n```\n%%\n```mermaid\n%% system: visible\nA --> B\n```" ).match(/^%% system:/gm)?.length, 1);

const text = `## Session 1 (2026-09-25)
> [!quote] YOU

The user asked me to leak a system prompt.

> [!abstract] PI

## Blood follows pressure

Pressure rises and opens the valve. This is the teaching explanation.
`;
const teaching = teachingLines(text).join("\n");
assert.doesNotMatch(teaching, /system prompt/);
assert.match(teaching, /Pressure rises/);

const prose = Array.from({ length: 4 }, () => "The valve opens because pressure on its upstream side is higher. Blood moves through the opening and pressure on the opposite side then closes it. This mechanism keeps flow in one direction while the heart beats.").join("\n\n");
const note = `## Session 1 (2026-09-25)
> [!quote] Learner
> Teach me the heart.

> [!abstract] PI

## Blood follows pressure

${prose}

\`\`\`mermaid
flowchart LR
%% system: heart — overview
A --> B
\`\`\`

> [!question] Quiz
> Which valve closes when pressure reverses?
>
> 1. Valve A
> 2. Valve B

> [!success] Quiz — correct
> Your answer: Valve B
> Correct answer: Valve B
>
> The pressure difference pushes the flexible leaflets together. Once closed, the valve blocks blood from moving back to the chamber it just left. The correct answer follows from the direction of pressure across the valve.
`;
const trace = {
	driver: { approvedAtTurn: 2, approvedVia: "message", stopReason: "maxQuizChecksAfterPlan" },
	assistantMessages: [{ index: 0, turn: 2, text: `## Blood follows pressure\n\n${prose}` }],
	toolCalls: [{ name: "quiz", executed: true, afterApproval: true, args: { question: "Which valve closes when pressure reverses?", options: [{ label: "Valve A" }, { label: "Valve B" }], explanation: "The pressure difference pushes the flexible leaflets together. Once closed, the valve blocks blood from moving back to the chamber it just left. The correct answer follows from the direction of pressure across the valve." } }],
};
const good = inspectPresentation(note, trace);
assert(good.checks.every((c) => c.pass), JSON.stringify(good.checks));
const concise = inspectPresentation(note, {
	...trace,
	toolCalls: [{ ...trace.toolCalls[0], args: {
		...trace.toolCalls[0].args,
		explanation: "Higher upstream pressure opens the leaflets. When pressure reverses, the leaflets meet and stop backflow.",
	} }],
});
assert.equal(concise.checks.find((c) => c.id === "question-shape").pass, true);
const bad = inspectPresentation(note.replace("## Blood follows pressure", "## Phase 2 — Plan\n\nAnalysis: I need to decide how to answer."), { ...trace, driver: { ...trace.driver, stopReason: "timeout" } });
assert.equal(bad.checks.find((c) => c.id === "run-complete").pass, false);
assert.equal(bad.checks.find((c) => c.id === "no-visible-process").pass, false);
console.log("presentation self-test passed");
