// Session fixtures for Obsidian-link integration tests: the same lesson expressed
// as persisted session entries (for backfill) and as live extension events.

export const VALID_MERMAID = "```mermaid\nflowchart TD\n%% dependency-map\n  A[Sorted array] --> B[Halving]\n```";
// Dangling edge: the stub validator (and real Mermaid) reject it.
export const INVALID_MERMAID = "```mermaid\nflowchart LR\n  A -->\n```";

export const QUIZ_ARGS = {
	question: "Why does binary search need a sorted array?",
	details: "Think about what one comparison tells you.",
	options: [{ label: "To discard half" }, { label: "To use less memory" }, { label: "It does not" }],
	correctAnswer: "To discard half",
	explanation: "SECRET-EXPLANATION: one comparison rules out a whole half only if order holds.",
};
// The order the learner actually saw (quiz shuffles inside execute()).
export const QUIZ_SHOWN = [
	{ index: 1, label: "It does not" },
	{ index: 2, label: "To discard half" },
	{ index: 3, label: "To use less memory" },
];
export const QUIZ_DETAILS = {
	status: "answered",
	question: QUIZ_ARGS.question,
	context: QUIZ_ARGS.details,
	mode: "single-select",
	answers: [{ index: 2, label: "To discard half", value: "To discard half" }],
	correctIndices: [2],
	options: QUIZ_SHOWN,
	correct: true,
	note: "felt sure",
	explanation: QUIZ_ARGS.explanation,
};

export const ASK_ARGS = {
	question: "What should we focus on next?",
	options: [{ label: "Proofs" }, { label: "Code" }],
};
export const ASK_DETAILS = {
	status: "answered",
	question: ASK_ARGS.question,
	answers: [{ type: "option", index: 2, label: "Code", value: "Code" }],
};

export const BLOCKED_QUIZ_ARGS = {
	question: "BLOCKED-QUESTION should never appear",
	options: [{ label: "x" }, { label: "y" }],
	correctAnswer: "x",
	explanation: "BLOCKED-EXPLANATION",
};

/** A tiny in-memory session tree: entries get ids and parentIds like pi's SessionManager. */
export function createSession(sessionId) {
	const entries = [];
	let n = 0;
	const append = (entry) => {
		const last = [...entries].reverse().find((e) => e.id);
		const full = { ...entry, id: `${sessionId.slice(0, 4)}${String(++n).padStart(4, "0")}`, parentId: last ? last.id : null, timestamp: new Date().toISOString() };
		entries.push(full);
		return full;
	};
	return {
		sessionId,
		entries,
		append,
		message: (message) => append({ type: "message", message }),
		custom: (customType, data) => append({ type: "custom", customType, data }),
		manager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ type: "session", id: sessionId }),
			getEntries: () => entries,
			getBranch: () => entries,
			appendCustomEntry: (customType, data) => append({ type: "custom", customType, data }).id,
		},
	};
}

const USER_TEXT = "Teach me binary search\n\n<skill name=\"teach\" location=\"x\">whole skill text</skill>";
const ASSISTANT_PLAIN = "We start from a sorted array.\n\nNo diagram in this one, just $\\log_2 n$ math.";
const ASSISTANT_MERMAID = `Here is the plan.\n\n${VALID_MERMAID}\n\nAnd a broken one:\n\n${INVALID_MERMAID}\n\nDone.`;

/**
 * Fill `session` with the lesson. `withMermaid` adds the assistant message with a valid + an
 * invalid diagram; `withBlocked` adds a quiz call that another extension blocked.
 */
export function fillLesson(session, { withMermaid = false, withBlocked = false } = {}) {
	session.message({ role: "user", content: USER_TEXT });
	session.message({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: ASSISTANT_PLAIN },
			{ type: "toolCall", id: "call-quiz-1", name: "quiz", arguments: QUIZ_ARGS },
		],
	});
	session.message({ role: "toolResult", toolCallId: "call-quiz-1", toolName: "quiz", content: [{ type: "text", text: "ok" }], isError: false, details: QUIZ_DETAILS });
	if (withBlocked) {
		session.message({ role: "assistant", content: [{ type: "toolCall", id: "call-quiz-blocked", name: "quiz", arguments: BLOCKED_QUIZ_ARGS }] });
		session.message({ role: "toolResult", toolCallId: "call-quiz-blocked", toolName: "quiz", content: [{ type: "text", text: "Blocked: add the diagram first" }], isError: true });
	}
	session.message({
		role: "assistant",
		content: [
			{ type: "text", text: withMermaid ? ASSISTANT_MERMAID : "Now a preference question." },
			{ type: "toolCall", id: "call-ask-1", name: "ask_user_question", arguments: ASK_ARGS },
			{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls" } },
		],
	});
	session.message({ role: "toolResult", toolCallId: "call-ask-1", toolName: "ask_user_question", content: [{ type: "text", text: "Code" }], isError: false, details: ASK_DETAILS });
	session.message({ role: "toolResult", toolCallId: "call-bash", toolName: "bash", content: [{ type: "text", text: "files" }], isError: false });
	return session;
}

/** The same lesson as live events: [eventName, event][] */
export function liveLessonEvents({ withMermaid = false, withBlocked = false } = {}) {
	const ev = [];
	ev.push(["message_end", { type: "message_end", message: { role: "user", content: USER_TEXT } }]);
	ev.push(["message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ASSISTANT_PLAIN }, { type: "toolCall", id: "call-quiz-1", name: "quiz", arguments: QUIZ_ARGS }] } }]);
	ev.push(["tool_call", { type: "tool_call", toolCallId: "call-quiz-1", toolName: "quiz", input: QUIZ_ARGS }]);
	ev.push(["tool_execution_update", { type: "tool_execution_update", toolCallId: "call-quiz-1", toolName: "quiz", args: QUIZ_ARGS, partialResult: { content: [], details: { options: QUIZ_SHOWN } } }]);
	ev.push(["tool_execution_update", { type: "tool_execution_update", toolCallId: "call-quiz-1", toolName: "quiz", args: QUIZ_ARGS, partialResult: { content: [], details: { options: QUIZ_SHOWN } } }]);
	ev.push(["tool_result", { type: "tool_result", toolCallId: "call-quiz-1", toolName: "quiz", input: QUIZ_ARGS, content: [], isError: false, details: QUIZ_DETAILS }]);
	if (withBlocked) {
		ev.push(["tool_call", { type: "tool_call", toolCallId: "call-quiz-blocked", toolName: "quiz", input: BLOCKED_QUIZ_ARGS }]);
		ev.push(["tool_result", { type: "tool_result", toolCallId: "call-quiz-blocked", toolName: "quiz", input: BLOCKED_QUIZ_ARGS, content: [{ type: "text", text: "Blocked" }], isError: true, details: undefined }]);
		// a result that did not come from the quiz tool itself (no status)
		ev.push(["tool_result", { type: "tool_result", toolCallId: "call-quiz-blocked", toolName: "quiz", input: BLOCKED_QUIZ_ARGS, content: [], isError: false, details: { reason: "BLOCKED-NO-STATUS" } }]);
	}
	ev.push(["message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: withMermaid ? ASSISTANT_MERMAID : "Now a preference question." }] } }]);
	ev.push(["tool_call", { type: "tool_call", toolCallId: "call-ask-1", toolName: "ask_user_question", input: ASK_ARGS }]);
	ev.push(["tool_result", { type: "tool_result", toolCallId: "call-ask-1", toolName: "ask_user_question", input: ASK_ARGS, content: [], isError: false, details: ASK_DETAILS }]);
	ev.push(["tool_result", { type: "tool_result", toolCallId: "call-bash", toolName: "bash", input: {}, content: [], isError: false, details: undefined }]);
	// custom messages (e.g. the hidden resume brief) are never logged
	ev.push(["message_end", { type: "message_end", message: { role: "custom", customType: "learn-resume", content: "BRIEF-SHOULD-NOT-BE-LOGGED", display: false } }]);
	return ev;
}
