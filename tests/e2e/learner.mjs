// Simulated learner + simulated TUI for live-model e2e sessions.
//
// `createSimulatedUI()` returns an ExtensionUIContext whose `custom(factory)` instantiates the
// REAL component the quiz / ask_user_question tool builds (with a fake tui, a plain-text theme
// and stub keybindings), then drives it with real key sequences through
// `component.handleInput()`, reading `component.render()` to find where options are.
//
// The learner "knows" the right answer because the harness captures the quiz tool-call args
// (`correctAnswer`, `options[].value/label`) from session events; the displayed (shuffled)
// position is recovered from the render output.

export const KEYS = Object.freeze({
	enter: "\r",
	down: "\x1b[B",
	up: "\x1b[A",
	tab: "\t",
	space: " ",
	esc: "\x1b",
});
const KEY_NAMES = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k]));

// CSI / OSC / APC (pi-tui's CURSOR_MARKER is an APC sequence) and stray control chars.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function stripAnsi(s) {
	return String(s).replace(ANSI_RE, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Deterministic PRNG so a run can be replayed with the same learner decisions. */
export function makeRng(seedText) {
	let h = 1779033703 ^ seedText.length;
	for (let i = 0; i < seedText.length; i++) {
		h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function makeFakeTheme() {
	const id = (s) => String(s ?? "");
	const base = {
		name: "e2e-plain",
		fg: (_color, s) => String(s ?? ""),
		bg: (_color, s) => String(s ?? ""),
		bold: id,
		italic: id,
		underline: id,
		strikethrough: id,
		inverse: id,
		dim: id,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
	};
	// Any other styling helper a component might call is an identity function.
	return new Proxy(base, {
		get(target, key) {
			if (key in target) return target[key];
			if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
			return id;
		},
	});
}

function makeFakeKeybindings() {
	const base = { matches: () => false, getKeys: () => [], getBindings: () => [] };
	return new Proxy(base, {
		get(target, key) {
			if (key in target) return target[key];
			if (typeof key === "symbol" || key === "then") return undefined;
			return () => undefined;
		},
	});
}

function makeFakeTui(width) {
	return {
		requestRender() {},
		terminal: { rows: 40, columns: width, write() {} },
		setFocus() {},
		invalidate() {},
	};
}

const norm = (s) => stripAnsi(String(s ?? "")).replace(/\s+/g, " ").trim().toLowerCase();

/** `correctAnswer` may arrive as a JSON-stringified array (same coercion quiz.ts does). */
function coerceCorrect(correctAnswer) {
	if (Array.isArray(correctAnswer)) return correctAnswer.map(String);
	if (correctAnswer === undefined || correctAnswer === null) return [];
	const t = String(correctAnswer).trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		try {
			const parsed = JSON.parse(t);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			/* literal */
		}
	}
	return [String(correctAnswer)];
}

/**
 * Parse the navigable rows of a quiz / ask_user_question component from its plain-text render.
 * Returns rows in navigation order: { kind: option|dontknow|other|submit, num?, label, checked, focused, line }.
 */
export function parseRows(lines) {
	const rows = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let m = /^(> |  )(\[( |x)\] )?(\d+)\. (.*)$/.exec(line);
		if (m) {
			rows.push({ kind: "option", num: Number(m[4]), label: m[5].trim(), checked: m[3] === "x", focused: m[1] === "> ", line: i });
			continue;
		}
		m = /^(> |  )(\[( |x)\] )?I don't know\s*$/.exec(line);
		if (m) {
			rows.push({ kind: "dontknow", label: "I don't know", checked: m[3] === "x", focused: m[1] === "> ", line: i });
			continue;
		}
		m = /^(> |  )(\[( |x)\] )?(Other(?: \(custom\))?)(?: — (.*))?\s*$/.exec(line);
		if (m) {
			rows.push({ kind: "other", label: m[4], checked: m[3] === "x", focused: m[1] === "> ", line: i });
			continue;
		}
		m = /^(> |  )(?:✓|○) Submit\b/.exec(line);
		if (m) {
			rows.push({ kind: "submit", label: "Submit", focused: m[1] === "> ", line: i });
		}
	}
	return rows;
}

function labelMatches(displayed, wanted) {
	const d = norm(displayed).replace(/…$|\.\.\.$/, "");
	const w = norm(wanted);
	if (!d || !w) return false;
	return d === w || w.startsWith(d) || d.startsWith(w);
}

/**
 * Create the simulated learner + UI context.
 *
 * @param {object} o
 * @param {() => number} o.rng
 * @param {number} o.p                 probability of a correct quiz answer
 * @param {number} o.dontKnowRate      probability of "I don't know"
 * @param {string} o.goal              free-text goal typed into text prompts
 * @param {(entry: object) => void} o.record  trace sink (kind, ...)
 * @param {() => Map} o.pendingCalls   toolCallId -> { id, name, args, shuffled? }
 * @param {number} [o.width]
 */
export function createSimulatedUI(o) {
	const width = o.width ?? 100;
	const theme = makeFakeTheme();
	const keybindings = makeFakeKeybindings();
	const tui = makeFakeTui(width);
	const decisions = [];
	const notifications = [];
	const statuses = {};
	const dialogs = [];

	function render(component) {
		const raw = component.render(width) || [];
		return raw.map(stripAnsi);
	}

	function press(component, key, keysLog) {
		keysLog.push(KEY_NAMES[key] ?? JSON.stringify(key));
		component.handleInput(key);
	}

	/** Move focus to rows[targetIdx] (navigation order), verifying against the render each step. */
	function navigateTo(component, targetIdx, keysLog) {
		for (let step = 0; step < 60; step++) {
			const rows = parseRows(render(component));
			const cur = rows.findIndex((r) => r.focused);
			if (cur === targetIdx) return rows;
			if (cur === -1) throw new Error("no focused row in render output");
			press(component, cur < targetIdx ? KEYS.down : KEYS.up, keysLog);
		}
		throw new Error(`could not navigate to row ${targetIdx}`);
	}

	function identifyCall(lines) {
		const pending = [...o.pendingCalls().values()].filter((c) => c.name === "quiz" || c.name === "ask_user_question");
		const text = norm(lines.join(" "));
		const byQuestion = pending.filter((c) => {
			const q = norm(c.args?.question).slice(0, 60);
			return q && text.includes(q);
		});
		if (byQuestion.length > 0) return byQuestion[0];
		return pending[0];
	}

	function chooseOutcome() {
		const r = o.rng();
		if (r < o.p) return "correct";
		if (r < o.p + Math.min(o.dontKnowRate, 1 - o.p)) return "dontknow";
		return "wrong";
	}

	function driveQuiz(component, call, isDone, decision) {
		const args = call.args || {};
		const multi = !!args.multiSelect;
		let lines = render(component);
		let rows = parseRows(lines);
		const optionRows = rows.filter((r) => r.kind === "option");
		decision.displayed = optionRows.map((r) => `${r.num}. ${r.label}`);
		if (call.shuffled) decision.shuffledFromUpdate = call.shuffled.map((x) => `${x.index}. ${x.label}`);

		// value -> label from the tool-call args, then label -> displayed number from the render.
		const opts = (args.options || []).map((op) => ({ label: String(op.label ?? "").trim(), value: String(op.value ?? op.label ?? "").trim() }));
		const correctValues = coerceCorrect(args.correctAnswer).map((v) => v.trim());
		const correctLabels = correctValues.map((v) => opts.find((op) => op.value === v)?.label).filter(Boolean);
		const correctNums = [];
		for (const label of correctLabels) {
			const row = optionRows.find((r) => labelMatches(r.label, label));
			if (row) correctNums.push(row.num);
		}
		decision.correctDisplayed = correctNums;
		if (correctNums.length === 0) decision.warning = "could not map correctAnswer to a displayed option";

		let outcome = chooseOutcome();
		if (outcome === "correct" && correctNums.length === 0) outcome = "dontknow";
		const wrongNums = optionRows.map((r) => r.num).filter((n) => !correctNums.includes(n));
		if (outcome === "wrong" && wrongNums.length === 0) outcome = "correct";
		decision.intended = outcome;

		const navIndexOfNum = (n) => rows.findIndex((r) => r.kind === "option" && r.num === n);
		const navIndexOf = (kind) => rows.findIndex((r) => r.kind === kind);
		const keys = decision.keys;

		if (!multi) {
			let target;
			if (outcome === "correct") target = navIndexOfNum(correctNums[0]);
			else if (outcome === "dontknow") target = navIndexOf("dontknow");
			else target = navIndexOfNum(wrongNums[Math.floor(o.rng() * wrongNums.length)]);
			rows = navigateTo(component, target, keys);
			decision.chosen = rows[target].kind === "dontknow" ? "I don't know" : `${rows[target].num}. ${rows[target].label}`;
			press(component, KEYS.enter, keys);
		} else {
			let toToggle;
			if (outcome === "correct") toToggle = correctNums.map(navIndexOfNum);
			else if (outcome === "dontknow") toToggle = [navIndexOf("dontknow")];
			else {
				// Plausible mistake: miss one correct option, or add one wrong option.
				const set = new Set(correctNums);
				if (set.size > 1 && o.rng() < 0.5) set.delete([...set][Math.floor(o.rng() * set.size)]);
				else set.add(wrongNums[Math.floor(o.rng() * wrongNums.length)]);
				toToggle = [...set].map(navIndexOfNum);
			}
			const chosen = [];
			for (const idx of toToggle) {
				rows = navigateTo(component, idx, keys);
				press(component, KEYS.space, keys);
				const after = parseRows(render(component))[idx];
				if (!after?.checked) throw new Error(`toggle did not check row ${idx}`);
				chosen.push(after.kind === "dontknow" ? "I don't know" : `${after.num}. ${after.label}`);
			}
			decision.chosen = chosen;
			rows = parseRows(render(component));
			navigateTo(component, rows.findIndex((r) => r.kind === "submit"), keys);
			press(component, KEYS.enter, keys);
		}

		// Feedback phase: read the verdict the component shows, then dismiss with Enter.
		lines = render(component);
		const joined = lines.join("\n");
		decision.feedbackShown = /Enter\/Esc to continue/.test(joined);
		decision.observed = /✓ Correct!/.test(joined)
			? "correct"
			: /✗ Incorrect\./.test(joined)
				? "wrong"
				: /You said: I don't know/.test(joined)
					? "dontknow"
					: "unknown";
		decision.consistent = decision.observed === decision.intended;
		press(component, KEYS.enter, keys);
		if (!isDone()) throw new Error("quiz component did not finish after dismissing feedback");
	}

	function driveAsk(component, call, isDone, decision) {
		const keys = decision.keys;
		let rows = parseRows(render(component));
		const options = rows.filter((r) => r.kind === "option");
		decision.displayed = options.map((r) => `${r.num}. ${r.label}`);
		const multi = rows.some((r) => r.kind === "submit");
		if (options.length > 0) {
			const idx = rows.findIndex((r) => r.kind === "option" && r.num === 1);
			rows = navigateTo(component, idx, keys);
			decision.chosen = `${rows[idx].num}. ${rows[idx].label}`;
			if (multi) {
				press(component, KEYS.space, keys);
				rows = parseRows(render(component));
				navigateTo(component, rows.findIndex((r) => r.kind === "submit"), keys);
			}
			press(component, KEYS.enter, keys);
		} else {
			// No options rendered: type the goal as a custom answer.
			const other = rows.findIndex((r) => r.kind === "other");
			if (other >= 0) {
				navigateTo(component, other, keys);
				press(component, KEYS.enter, keys);
			}
			typeText(component, o.goal, keys);
			press(component, KEYS.enter, keys);
			decision.chosen = `typed: ${o.goal}`;
		}
		if (!isDone()) throw new Error("ask_user_question component did not finish");
	}

	function typeText(component, text, keys) {
		for (const ch of text) component.handleInput(ch);
		keys.push(`type(${text.length} chars)`);
	}

	async function custom(factory, _options) {
		const startedAt = Date.now();
		let finished = false;
		let resolveResult;
		const result = new Promise((r) => (resolveResult = r));
		const done = (value) => {
			if (finished) return;
			finished = true;
			resolveResult(value);
		};
		const component = await factory(tui, theme, keybindings, done);
		const lines = render(component);
		const call = identifyCall(lines);
		const decision = {
			at: startedAt,
			toolCallId: call?.id ?? null,
			tool: call?.name ?? "unknown",
			question: call?.args?.question ?? lines.slice(1, 3).join(" ").trim(),
			mode: call?.args?.multiSelect ? "multi-select" : "single-select",
			keys: [],
		};
		decisions.push(decision);
		try {
			if (call?.name === "quiz") driveQuiz(component, call, () => finished, decision);
			else if (call?.name === "ask_user_question") driveAsk(component, call, () => finished, decision);
			else throw new Error("custom component not attributable to a pending quiz/ask_user_question call");
		} catch (err) {
			decision.error = err instanceof Error ? err.message : String(err);
			decision.renderAtError = render(component);
			if (!finished) component.handleInput(KEYS.esc); // cancel rather than hang
			if (!finished) {
				// Esc may only leave a sub-mode; try once more, then give up with undefined.
				component.handleInput(KEYS.esc);
			}
			if (!finished) done(undefined);
		} finally {
			try {
				component.dispose?.();
			} catch {
				/* ignore */
			}
		}
		decision.durationMs = Date.now() - startedAt;
		o.record({ kind: "learner", ...decision, renderAtError: undefined });
		return result;
	}

	const ui = {
		select: async (title, options) => {
			const answer = options?.[0];
			dialogs.push({ type: "select", title, options, answer });
			o.record({ kind: "ui-dialog", type: "select", title, answer });
			return answer;
		},
		confirm: async (title, message) => {
			dialogs.push({ type: "confirm", title, message, answer: true });
			o.record({ kind: "ui-dialog", type: "confirm", title, answer: true });
			return true;
		},
		input: async (title, placeholder) => {
			dialogs.push({ type: "input", title, placeholder, answer: o.goal });
			o.record({ kind: "ui-dialog", type: "input", title, answer: o.goal });
			return o.goal;
		},
		editor: async (title, prefill) => {
			// ask_user_question's free-text mode: the learner types their goal and submits.
			const pendingAsk = [...o.pendingCalls().values()].find((c) => c.name === "ask_user_question");
			const decision = {
				at: Date.now(),
				toolCallId: pendingAsk?.id ?? null,
				tool: pendingAsk ? "ask_user_question" : "editor",
				question: title,
				mode: "text",
				chosen: `typed: ${o.goal}`,
				keys: [`type(${o.goal.length} chars)`, "enter"],
			};
			decisions.push(decision);
			o.record({ kind: "learner", ...decision, prefill });
			return o.goal;
		},
		notify: (message, type) => {
			notifications.push({ at: Date.now(), message, type });
			o.record({ kind: "notify", message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			statuses[key] = text === undefined ? undefined : stripAnsi(text);
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "simulated UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return { ui, decisions, notifications, statuses, dialogs };
}
