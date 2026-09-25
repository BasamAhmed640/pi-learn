/** Search, inspect and import a real Wikimedia Commons image for an Obsidian lesson. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import {
	CommonsImageError,
	importCommonsImage,
	previewCommonsImage,
	searchCommonsImages,
	type CommonsCandidate,
} from "./lib/commons-images.ts";
import { findVaultRoot } from "./lib/obsidian-style.ts";
import { linkedNoteFromEntries } from "./lib/learn-link-state.ts";

const REFERENCE_IMAGE_POLICY = `REAL REFERENCE IMAGES IN LINKED OBSIDIAN LESSONS.
In Phase 2, plan concrete visual learning moments alongside the dependency-map nodes. For each proposed image, identify the exact visible feature the learner needs to inspect and the understanding or recognition it supports. Name those moments in the lesson approach, then search and import only when teaching the relevant node in Phase 3. Do not gather pictures at the end or plan an image quota.

At the start of a lesson and at each new concept, ask whether seeing the real object, material, anatomy, place, or physical layout would make it easier to understand or recognize. For a visually grounded topic (for example, an ASIC die, package bumps, an interposer, or a silicon capacitor), search with search_commons_images at the first relevant explanation by default. An early orientation image can help even when the first detailed node is mathematical. Do not wait until a late node if a real picture would give the learner a useful mental anchor now. Before searching, complete this sentence with a specific visible feature and learning goal: "The learner needs to see [needed_view] to understand or recognize [learning_goal]." A generic topic or decorative picture is not a reason to search.

Use a short, concrete search phrase naming the visible subject, not the whole lesson question. If results are empty or off-topic, broaden the query only; keep the original needed_view and learning_goal. Never substitute an LGA underside for a BGA solder-ball view. If a different lesson node needs a genuinely different image, begin a new visual goal and state why the previous one was abandoned. Before importing, inspect the preview. It must clearly and accurately show the needed view, have usable creator and license information, and support a sentence telling the learner what to notice. Call import_commons_image only when a candidate passes those checks, supplying what_to_notice and descriptive alt_text. Place the returned image, observation, and attribution block together beside the relevant explanation. A good image earns its place by showing something the learner could not see as well in prose.

Search is the default for a visually grounded lesson; import is never a quota. If no suitable preview exists or import fails, continue without an image. Avoid decorative, misleading, repeated, or low-resolution pictures. Keep Mermaid diagrams for interacting systems and plots for quantitative relationships; a real image complements them rather than replacing them.`;

function linkedVaultNote(ctx: any): string | null {
	const file = linkedNoteFromEntries(ctx.sessionManager?.getEntries?.() ?? []);
	if (typeof file !== "string" || !file) return null;
	try {
		return existsSync(file) && findVaultRoot(file) ? file : null;
	} catch {
		return null;
	}
}

function concreteText(value: unknown, label: string, max = 180): string | null {
	if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) return `${label} must be one concrete, plain-text phrase.`;
	const text = value.trim().replace(/\s+/g, " ");
	if (text.length < 8 || text.length > max || /^(?:something|anything|an? (?:image|picture|photo)|the (?:image|picture|photo|topic)|this|it|visual)$/i.test(text)) {
		return `${label} must name a specific visual detail or learning goal (8–${max} characters).`;
	}
	return null;
}

function markdownText(value: string): string {
	return value.trim().replace(/[\\`*_{}\[\]()<>|]/g, "\\$&");
}

function observationText(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/^(?:notice\b(?:\s*:\s*|\s+))+/i, "").trim() : "";
}

interface VisualIntent {
	query: string;
	neededView: string;
	learningGoal: string;
}

interface PreviewedImage {
	candidate: CommonsCandidate;
	preview: { data: string; mimeType: string };
	intent: VisualIntent;
	priorIntents: VisualIntent[];
	abandonedIntents: VisualIntent[];
	newGoalReason: string | null;
}

const IMAGE_REVIEW_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REVIEWS_PER_SESSION = 12;
const IMAGE_REVIEW_PROMPT = `You are an independent visual accuracy gate for an educational image import. Inspect the attached image pixels. Do not accept the tutor's proposed description, Commons title, or the newest broad search phrase as proof of what the image shows.
The original specific visual need remains binding across retries. A broad later search must not substitute a visually different object. In particular, a BGA underside needs solder balls; flat LGA contact pads do not satisfy it. Decide whether this exact preview clearly and accurately teaches the original and latest stated need. If uncertain, illegible, wrong subject, or unable to inspect the image, reject.
An explicit new visual goal can start a different lesson node. If prior goals were abandoned, check that the current goal is genuinely distinct rather than a diluted restatement of an earlier visual need.
Return ONLY JSON: {"verdict":"match"|"mismatch"|"uncertain","observed_subject":"brief visual description","reason":"brief explanation"}. Use match only when visible evidence clearly supports the needed view.`;

function explicitPackageMismatch(intents: VisualIntent[], candidate: CommonsCandidate, whatToNotice: string, altText: string): string | null {
	const need = intents.map((intent) => `${intent.query} ${intent.neededView} ${intent.learningGoal}`).join(" ");
	const claimed = `${candidate.title} ${whatToNotice} ${altText}`;
	// A specific package need cannot be replaced by a broad phrase about contacts.
	if (/\bBGA\b|solder balls?/i.test(need) && /\bLGA\b|flat (?:gold )?(?:contact )?pads?|flat gold contacts/i.test(claimed)) {
		return "The selected image is described as LGA or flat contact pads, while this visual moment needs BGA solder balls. Choose a preview that visibly shows solder balls, or continue without an image.";
	}
	if (/\bLGA\b|flat (?:gold )?(?:contact )?pads?/i.test(need) && /\bBGA\b|solder balls?/i.test(claimed)) {
		return "The selected image is described as BGA or solder balls, while this visual moment needs LGA contact pads. Choose a matching preview, or continue without an image.";
	}
	return null;
}

function dilutedPackageGoal(previous: VisualIntent, next: VisualIntent): boolean {
	const before = `${previous.neededView} ${previous.learningGoal}`;
	const after = `${next.neededView} ${next.learningGoal}`;
	const broadContacts = /\b(?:package|board|underside|contact|pad|grid|array|connection)s?\b/i.test(after);
	if (/\bBGA\b|solder balls?/i.test(before) && !/\b(?:BGA|LGA|interposer|substrate|microbump|wire bond|flip chip)\b/i.test(after) && broadContacts) return true;
	if (/\bLGA\b|flat (?:gold )?(?:contact )?pads?/i.test(before) && !/\b(?:BGA|LGA|interposer|substrate|microbump|wire bond|flip chip)\b/i.test(after) && broadContacts) return true;
	return false;
}

function reviewText(message: any): string {
	return Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
}

async function reviewPreview(ctx: any, selected: PreviewedImage, whatToNotice: string, altText: string): Promise<{ match: boolean; reason: string }> {
	if (!ctx?.model || typeof ctx?.modelRegistry?.streamSimple !== "function") {
		return { match: false, reason: "An image-capable reviewer is unavailable." };
	}
	if (Array.isArray(ctx.model.input) && !ctx.model.input.includes("image")) {
		return { match: false, reason: "The active model cannot inspect images." };
	}
	try {
		const original = selected.priorIntents[0] ?? selected.intent;
		const userText = `Original visual need: The learner needs to see ${original.neededView} to understand or recognize ${original.learningGoal}.\nOriginal search: ${original.query}\nLatest visual need: The learner needs to see ${selected.intent.neededView} to understand or recognize ${selected.intent.learningGoal}.\nLatest search: ${selected.intent.query}\nOther search attempts for this visual moment: ${selected.priorIntents.slice(1, -1).map((x) => `${x.neededView} / ${x.learningGoal}`).join("; ") || "none"}\nEarlier abandoned visual goals: ${selected.abandonedIntents.map((x) => `${x.neededView} / ${x.learningGoal}`).join("; ") || "none"}\nStated reason for changing to a genuinely different lesson node: ${selected.newGoalReason ?? "none"}\nCommons title: ${selected.candidate.title}\nTutor's proposed observation: ${whatToNotice}\nTutor's proposed alt text: ${altText}\nDoes the attached preview visually meet the original specific learning need?`;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const stream = ctx.modelRegistry.streamSimple(
			ctx.model,
			{
				systemPrompt: IMAGE_REVIEW_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: userText }, { type: "image", ...selected.preview }], timestamp: Date.now() }],
			},
			{ reasoning: "minimal", signal: AbortSignal.timeout(IMAGE_REVIEW_TIMEOUT_MS), ...(sessionId ? { sessionId } : {}) },
		);
		const message = await stream.result();
		if (!message || message.stopReason === "error" || message.stopReason === "aborted") return { match: false, reason: "The image reviewer could not inspect this preview." };
		const raw = reviewText(message).trim();
		const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
		const answer = JSON.parse(json);
		if (answer?.verdict !== "match") return { match: false, reason: typeof answer?.reason === "string" ? answer.reason.slice(0, 250) : "The preview does not clearly match the visual learning need." };
		if (typeof answer.observed_subject !== "string" || answer.observed_subject.trim().length < 4) return { match: false, reason: "The image reviewer did not describe visible evidence." };
		return { match: true, reason: answer.reason ?? "" };
	} catch {
		return { match: false, reason: "The image review was unavailable or ambiguous." };
	}
}

export default function (pi: ExtensionAPI) {
	// A candidate can only be imported after its thumbnail has been shown to the tutor.
	let previewed = new Map<string, PreviewedImage>();
	let pendingIntents: VisualIntent[] = [];
	let abandonedIntents: VisualIntent[] = [];
	let newGoalReason: string | null = null;
	let imageReviewsThisSession = 0;
	pi.on("session_start", () => { previewed = new Map(); pendingIntents = []; abandonedIntents = []; newGoalReason = null; imageReviewsThisSession = 0; });

	pi.on("before_agent_start", (event, ctx) => {
		if (linkedVaultNote(ctx)) event.systemPromptOptions.sections.reference_images = REFERENCE_IMAGE_POLICY;
	});

	pi.registerTool({
		name: "search_commons_images",
		label: "Search Commons images",
		description:
			"Search Wikimedia Commons for real photos or other raster reference images. Returns up to four " +
			"small previews with their file IDs, source and license. Inspect the previews, choose only an image " +
			"that answers the stated visual learning need, then call import_commons_image with its candidate_id. " +
			"A web image supplements the lesson; system diagrams still belong in inline Mermaid. " +
			"If results are off-topic, broaden the query but keep the original visual need. To move to a genuinely different lesson node, set start_new_goal with a reason. Otherwise continue without an image.",
		parameters: Type.Object({
			query: Type.String({ description: "A specific subject to illustrate, 1–120 characters." }),
			needed_view: Type.String({ description: "Complete 'The learner needs to see ___': name the exact visible feature or object, such as a BGA package underside." }),
			learning_goal: Type.String({ description: "Complete 'to understand or recognize ___': name the concept the view teaches, such as how solder balls connect a package to its board." }),
			start_new_goal: Type.Optional(Type.Boolean({ description: "True only when moving to a genuinely different lesson concept, not when broadening a failed search." })),
			new_goal_reason: Type.Optional(Type.String({ description: "When start_new_goal is true, explain which different lesson concept now needs an image and why the previous view was abandoned." })),
		}),
		async execute(_id, params) {
			previewed = new Map();
			const invalid = concreteText(params.needed_view, "needed_view") ?? concreteText(params.learning_goal, "learning_goal");
			if (invalid) return { content: [{ type: "text", text: `${invalid} Explain what the learner needs to see before searching.` }], details: { count: 0, error: invalid } };
			const intent: VisualIntent = { query: String(params.query).trim(), neededView: params.needed_view.trim(), learningGoal: params.learning_goal.trim() };
			if (params.start_new_goal) {
				const reasonInvalid = concreteText(params.new_goal_reason, "new_goal_reason", 240);
				if (reasonInvalid) return { content: [{ type: "text", text: `${reasonInvalid} A new visual goal must name the genuinely different lesson concept; retrying the same view should preserve the original need.` }], details: { count: 0, error: reasonInvalid } };
				if (pendingIntents.length > 0 && dilutedPackageGoal(pendingIntents[0], intent)) {
					const message = "This looks like a broader restatement of the same package-contact view. Keep the original needed_view and learning_goal, broaden only the query, and continue without an image if no preview matches.";
					return { content: [{ type: "text", text: message }], details: { count: 0, error: message } };
				}
				abandonedIntents = [...abandonedIntents, ...pendingIntents].slice(-6);
				pendingIntents = [];
				newGoalReason = params.new_goal_reason.trim();
			}
			pendingIntents.push(intent);
			if (pendingIntents.length > 6) pendingIntents = [pendingIntents[0], ...pendingIntents.slice(-5)];
			try {
				const results = await searchCommonsImages(params.query, { limit: 4 });
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
				for (const candidate of results) {
					try {
						const preview = await previewCommonsImage(candidate);
						previewed.set(candidate.id, { candidate, preview, intent, priorIntents: [...pendingIntents], abandonedIntents: [...abandonedIntents], newGoalReason });
						content.push({ type: "text", text: `Candidate ${candidate.id}: ${candidate.title}\nArtist: ${candidate.artist}\nLicense: ${candidate.license}\nSource: ${candidate.sourceUrl}` });
						content.push({ type: "image", ...preview });
					} catch {
						// An unavailable or oversized preview is not safe to select blindly.
					}
				}
				if (previewed.size === 0) {
					return { content: [{ type: "text", text: "No previewable Commons image was found. For a visually grounded lesson, try one broader concrete subject; if that also fails, continue without a web image." }], details: { count: 0 } };
				}
				content.unshift({ type: "text", text: `The learner needs to see ${params.needed_view.trim()} to understand or recognize ${params.learning_goal.trim()}. Earlier specific visual needs from this search sequence still apply. Inspect these ${previewed.size} Commons previews for the intended view. Import only a relevant one by candidate_id, with what_to_notice and alt_text; otherwise continue without an image.` });
				return { content, details: { count: previewed.size, candidateIds: [...previewed.keys()] } };
			} catch (error) {
				const message = error instanceof CommonsImageError ? error.message : "Commons image search failed. Continue without a web image.";
				return { content: [{ type: "text", text: message }], details: { count: 0, error: message } };
			}
		},
	});

	pi.registerTool({
		name: "import_commons_image",
		label: "Import Commons image",
		description:
			"Import a previously previewed Wikimedia Commons candidate into this lesson's Obsidian vault. " +
			"First confirm the preview clearly shows the intended subject and has creator/license information. " +
			"State the feature to notice and meaningful alternative text. Returns a ready-to-place local image, " +
			"observation, and attribution block; include the complete block beside the relevant explanation.",
		parameters: Type.Object({
			candidate_id: Type.String({ description: "The exact candidate ID from the latest search_commons_images result." }),
			what_to_notice: Type.String({ description: "A concise sentence telling the learner exactly which visible feature in this preview supports the current concept." }),
			alt_text: Type.String({ description: "Describe the information visible in the image for a learner who cannot see it; avoid generic labels such as 'image'." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const selected = previewed.get(String(params.candidate_id));
			if (!selected) {
				return { content: [{ type: "text", text: "That image was not previewed in the latest Commons search. Search again and inspect a preview before importing." }], details: { ok: false } };
			}
			const observation = observationText(params.what_to_notice);
			const invalid = concreteText(observation, "what_to_notice", 260) ?? concreteText(params.alt_text, "alt_text", 240);
			if (invalid) return { content: [{ type: "text", text: `${invalid} Inspect the preview and describe what it actually shows before importing.` }], details: { ok: false, error: invalid } };
			const mismatch = explicitPackageMismatch(selected.priorIntents, selected.candidate, observation, params.alt_text);
			if (mismatch) return { content: [{ type: "text", text: mismatch }], details: { ok: false, error: mismatch } };
			if (imageReviewsThisSession >= MAX_IMAGE_REVIEWS_PER_SESSION) return { content: [{ type: "text", text: "Image review limit reached for this Pi session. Continue the lesson without another web image." }], details: { ok: false, error: "image review limit reached" } };
			imageReviewsThisSession++;
			const reviewed = await reviewPreview(ctx, selected, observation, params.alt_text);
			if (!reviewed.match) {
				const message = `This preview was not imported: ${reviewed.reason} Search for a more precise view of ${selected.priorIntents[0]?.neededView ?? selected.intent.neededView}, or continue without an image.`;
				return { content: [{ type: "text", text: message }], details: { ok: false, error: reviewed.reason } };
			}
			try {
				const linkedNote = linkedVaultNote(ctx);
				const imported = await importCommonsImage(selected.candidate, { cwd: ctx.cwd, linkedNote, altText: params.alt_text.trim() });
				pendingIntents = [];
				abandonedIntents = [];
				newGoalReason = null;
				previewed = new Map();
				const block = `${imported.embed}\n\n*Notice: ${markdownText(observation)}*\n\n${imported.attribution}`;
				return {
					content: [{ type: "text", text: `${imported.reused ? "Reused" : "Saved"} a local image in this vault. Place this complete block beside the relevant explanation:\n\n${block}` }],
					details: { ok: true, path: imported.path, embed: imported.embed, block, attribution: imported.attribution, bytes: imported.bytes },
				};
			} catch (error) {
				const message = error instanceof CommonsImageError ? error.message : "The Commons image could not be imported. Continue without it.";
				return { content: [{ type: "text", text: message }], details: { ok: false, error: message } };
			}
		},
	});
}
