/** Persisted session link. Older Pi sessions used the md-log entry name. */
export const LEARN_LINK_ENTRY = "learn-link";
export const LEGACY_LINK_ENTRY = "md-log";

export function linkedNoteFromEntries(entries: readonly any[]): string | null {
	let file: string | null = null;
	for (const entry of entries) {
		if (entry?.type !== "custom") continue;
		if (entry.customType !== LEARN_LINK_ENTRY && entry.customType !== LEGACY_LINK_ENTRY) continue;
		file = typeof entry.data?.file === "string" ? entry.data.file : null;
	}
	return file;
}
