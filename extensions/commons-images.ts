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

const REFERENCE_IMAGE_POLICY = `REAL REFERENCE IMAGES IN LINKED OBSIDIAN LESSONS.
At the start of a lesson and at each new concept, ask whether seeing the real object, material, anatomy, place, or physical layout would make it easier to understand or recognize. For a visually grounded topic (for example, an ASIC die, package bumps, an interposer, or a silicon capacitor), search with search_commons_images at the first relevant explanation by default. An early orientation image can help even when the first detailed node is mathematical. Do not wait until a late node if a real picture would give the learner a useful mental anchor now.

Use a short, concrete search phrase naming the visible subject, not the whole lesson question. If results are empty or off-topic, try one broader physical-object term. Inspect the previews, source, and license. Import only a clearly relevant, accurate image with import_commons_image. Put its local Obsidian embed and attribution together beside the explanation, and say what feature to notice. A good image earns its place by showing something the learner could not see as well in prose.

Search is the default for a visually grounded lesson; import is never a quota. If no suitable preview exists or import fails, continue without an image. Avoid decorative, misleading, repeated, or low-resolution pictures. Keep Mermaid diagrams for interacting systems and plots for quantitative relationships; a real image complements them rather than replacing them.`;

function linkedVaultNote(ctx: any): string | null {
	let file: string | null = null;
	for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
		if (entry?.type === "custom" && entry.customType === "md-log") file = entry.data?.file ?? null;
	}
	if (typeof file !== "string" || !file) return null;
	try {
		return existsSync(file) && findVaultRoot(file) ? file : null;
	} catch {
		return null;
	}
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
			"that accurately illustrates the current lesson, then call import_commons_image with its candidate_id. " +
			"A web image supplements the lesson; system diagrams still belong in inline Mermaid. " +
			"In a visually grounded linked lesson, retry once with a broader concrete subject if results are empty or off-topic; otherwise continue without an image.",
		parameters: Type.Object({
			query: Type.String({ description: "A specific subject to illustrate, 1–120 characters." }),
		}),
		async execute(_id, params) {
			previewed = new Map();
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
				content.unshift({ type: "text", text: `Inspect these ${previewed.size} Commons previews. Import only a relevant one by candidate_id; otherwise continue without an image.` });
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
			"Returns a local Obsidian image embed and required attribution. Put both together in your " +
			"teaching reply at the relevant point. Never invent an embed or omit the attribution.",
		parameters: Type.Object({
			candidate_id: Type.String({ description: "The exact candidate ID from the latest search_commons_images result." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const candidate = previewed.get(String(params.candidate_id));
			if (!candidate) {
				return { content: [{ type: "text", text: "That image was not previewed in the latest Commons search. Search again and inspect a preview before importing." }], details: { ok: false } };
			}
			try {
				const linkedNote = (globalThis as any).__piLearn?.linkedNote as string | null | undefined;
				const imported = await importCommonsImage(candidate, { cwd: ctx.cwd, linkedNote });
				return {
					content: [{ type: "text", text: `${imported.reused ? "Reused" : "Saved"} a local image in this vault. Place these lines together in the lesson:\n\n${imported.embed}\n\n${imported.attribution}` }],
					details: { ok: true, path: imported.path, embed: imported.embed, attribution: imported.attribution, bytes: imported.bytes },
				};
			} catch (error) {
				const message = error instanceof CommonsImageError ? error.message : "The Commons image could not be imported. Continue without it.";
				return { content: [{ type: "text", text: message }], details: { ok: false, error: message } };
			}
		},
	});
}
