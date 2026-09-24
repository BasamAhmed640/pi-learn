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

Use a short, concrete search phrase naming the visible subject, not the whole lesson question. If results are empty or off-topic, try one broader physical-object term. Before importing, inspect the preview. It must clearly and accurately show the needed view, have usable creator and license information, and support a sentence telling the learner what to notice. Call import_commons_image only when a candidate passes those checks, supplying what_to_notice and descriptive alt_text. Place the returned image, observation, and attribution block together beside the relevant explanation. A good image earns its place by showing something the learner could not see as well in prose.

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

export default function (pi: ExtensionAPI) {
	// A candidate can only be imported after its thumbnail has been shown to the tutor.
	let previewed = new Map<string, CommonsCandidate>();

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
			"In a visually grounded linked lesson, retry once with a broader concrete subject if results are empty or off-topic; otherwise continue without an image.",
		parameters: Type.Object({
			query: Type.String({ description: "A specific subject to illustrate, 1–120 characters." }),
			needed_view: Type.String({ description: "Complete 'The learner needs to see ___': name the exact visible feature or object, such as a BGA package underside." }),
			learning_goal: Type.String({ description: "Complete 'to understand or recognize ___': name the concept the view teaches, such as how solder balls connect a package to its board." }),
		}),
		async execute(_id, params) {
			previewed = new Map();
			const invalid = concreteText(params.needed_view, "needed_view") ?? concreteText(params.learning_goal, "learning_goal");
			if (invalid) return { content: [{ type: "text", text: `${invalid} Explain what the learner needs to see before searching.` }], details: { count: 0, error: invalid } };
			try {
				const results = await searchCommonsImages(params.query, { limit: 4 });
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
				for (const candidate of results) {
					try {
						const preview = await previewCommonsImage(candidate);
						previewed.set(candidate.id, candidate);
						content.push({ type: "text", text: `Candidate ${candidate.id}: ${candidate.title}\nArtist: ${candidate.artist}\nLicense: ${candidate.license}\nSource: ${candidate.sourceUrl}` });
						content.push({ type: "image", ...preview });
					} catch {
						// An unavailable or oversized preview is not safe to select blindly.
					}
				}
				if (previewed.size === 0) {
					return { content: [{ type: "text", text: "No previewable Commons image was found. For a visually grounded lesson, try one broader concrete subject; if that also fails, continue without a web image." }], details: { count: 0 } };
				}
				content.unshift({ type: "text", text: `The learner needs to see ${params.needed_view.trim()} to understand or recognize ${params.learning_goal.trim()}. Inspect these ${previewed.size} Commons previews for that exact view. Import only a relevant one by candidate_id, with what_to_notice and alt_text; otherwise continue without an image.` });
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
			const candidate = previewed.get(String(params.candidate_id));
			if (!candidate) {
				return { content: [{ type: "text", text: "That image was not previewed in the latest Commons search. Search again and inspect a preview before importing." }], details: { ok: false } };
			}
			const invalid = concreteText(params.what_to_notice, "what_to_notice", 260) ?? concreteText(params.alt_text, "alt_text", 240);
			if (invalid) return { content: [{ type: "text", text: `${invalid} Inspect the preview and describe what it actually shows before importing.` }], details: { ok: false, error: invalid } };
			try {
				const linkedNote = linkedVaultNote(ctx);
				const imported = await importCommonsImage(candidate, { cwd: ctx.cwd, linkedNote, altText: params.alt_text.trim() });
				const block = `${imported.embed}\n\n*Notice: ${markdownText(params.what_to_notice)}*\n\n${imported.attribution}`;
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
