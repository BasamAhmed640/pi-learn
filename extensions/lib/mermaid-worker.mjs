// Worker thread for extensions/lib/mermaid.ts. Plain JavaScript on purpose: Node runs it
// directly (no jiti, no type stripping) no matter how the parent module was loaded.
//
// Mermaid needs a DOM (DOMPurify, d3). The DOM shim (linkedom) is installed on THIS worker's
// globals only, so pi's main thread never sees `window`, `document` or `navigator`.
//
// Protocol: parent posts { id, source }; worker replies with one of
//   { id, status: "valid", diagramType }
//   { id, status: "invalid", error }
//   { id, status: "unavailable", error }
import { parentPort } from "node:worker_threads";

// Anything Mermaid (or its dependencies) logs must not reach pi's terminal UI.
for (const method of ["log", "info", "warn", "error", "debug", "trace"]) console[method] = () => {};

let mermaidPromise = null;

async function loadMermaid() {
	const { parseHTML } = await import("linkedom");
	const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	// DOMPurify captures `window` when it is first evaluated, so this must precede the mermaid import.
	globalThis.window = dom.window;
	globalThis.document = dom.document;
	for (const name of [
		"Element",
		"HTMLElement",
		"SVGElement",
		"Node",
		"Text",
		"Comment",
		"DocumentFragment",
		"HTMLTemplateElement",
		"HTMLFormElement",
		"NamedNodeMap",
		"NodeFilter",
		"DOMParser",
	]) {
		if (globalThis[name] === undefined && dom[name] !== undefined) globalThis[name] = dom[name];
	}
	const mod = await import("mermaid");
	const mermaid = mod.default ?? mod;
	mermaid.initialize({ startOnLoad: false, logLevel: 5, securityLevel: "strict" });
	return mermaid;
}

function message(error) {
	if (error && typeof error === "object" && "message" in error) return String(error.message);
	return String(error);
}

// Keep the useful parts of a jison/langium error within ~300 characters.
function shortError(error) {
	const raw = message(error).replace(/\r/g, "");
	const jison = /Parse error on line (\d+):\n([^\n]*)\n(-*)\^\n?([\s\S]*)/.exec(raw);
	if (jison) {
		const [, line, context, dashes, rest] = jison;
		const col = dashes.length;
		const near = context.slice(Math.max(0, col - 30), col + 20).trim();
		const got = /got '([^']*)'/.exec(rest);
		const expecting = /Expecting ([^\n]*?)(?:, got '[^']*')?$/m.exec(rest);
		let text = `Parse error on line ${line} near "${near}"`;
		// jison reports end of input as token '1' (or 'EOF').
		if (got) text += got[1] === "1" || got[1] === "EOF" ? ": unexpected end of input" : `: unexpected '${got[1]}'`;
		if (expecting) text += `; expecting ${expecting[1]}`;
		return clip(text);
	}
	const lexical = /Lexical error on line (\d+)\. Unrecognized text\.\n([^\n]*)\n(-*)\^/.exec(raw);
	if (lexical) {
		const [, line, context, dashes] = lexical;
		const col = dashes.length;
		return clip(`Lexical error on line ${line}: unrecognized text near "${context.slice(Math.max(0, col - 30), col + 20).trim()}"`);
	}
	return clip(raw.replace(/\s*\n\s*/g, " ").trim() || "Unknown Mermaid error");
}

function clip(text) {
	return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

// A TypeError/ReferenceError from inside parse means the DOM shim is missing something,
// not that the diagram is wrong. Report it as "unavailable" so callers fail open.
function isInfrastructureError(error) {
	return error instanceof TypeError || error instanceof ReferenceError;
}

parentPort.on("message", async (request) => {
	const id = request?.id;
	let mermaid;
	try {
		mermaid = await (mermaidPromise ??= loadMermaid());
	} catch (error) {
		mermaidPromise = null;
		parentPort.postMessage({ id, status: "unavailable", error: clip(`Mermaid could not be loaded: ${message(error)}`) });
		return;
	}
	try {
		const result = await mermaid.parse(String(request?.source ?? ""));
		if (result && typeof result === "object" && typeof result.diagramType === "string") {
			parentPort.postMessage({ id, status: "valid", diagramType: result.diagramType });
		} else {
			parentPort.postMessage({ id, status: "invalid", error: "Mermaid did not recognise this diagram" });
		}
	} catch (error) {
		if (isInfrastructureError(error)) {
			parentPort.postMessage({ id, status: "unavailable", error: clip(`Mermaid validator failed: ${message(error)}`) });
		} else {
			parentPort.postMessage({ id, status: "invalid", error: shortError(error) });
		}
	}
});
