/** Search, inspect and import a real Wikimedia Commons image for an Obsidian lesson. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	CommonsImageError,
	importCommonsImage,
	previewCommonsImage,
	searchCommonsImages,
	type CommonsCandidate,
} from "./lib/commons-images.ts";

export default function (pi: ExtensionAPI) {
	// A candidate can only be imported after its thumbnail has been shown to the tutor.
	let previewed = new Map<string, CommonsCandidate>();

	pi.registerTool({
		name: "search_commons_images",
		label: "Search Commons images",
		description:
			"Search Wikimedia Commons for real photos or other raster reference images. Returns up to four " +
			"small previews with their file IDs, source and license. Inspect the previews, choose only an image " +
			"that accurately illustrates the current lesson, then call import_commons_image with its candidate_id. " +
			"A web image supplements the lesson; system diagrams still belong in inline Mermaid. " +
			"If no relevant preview appears, continue without a web image.",
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
					return { content: [{ type: "text", text: "No previewable Commons image was found. Continue the lesson without a web image." }], details: { count: 0 } };
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
