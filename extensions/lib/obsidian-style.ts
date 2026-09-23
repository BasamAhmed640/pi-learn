/**
 * obsidian-style — install pi-learn's CSS snippet into the vault that holds a
 * learning note, and enable it once.
 *
 * Same ownership rules as pi-scholar's appearance installer:
 *   - The snippet lives at <vault>/.obsidian/snippets/pi-learn.css.
 *   - A receipt (<vault>/.obsidian/pi-learn-appearance.json) records the hash of
 *     what pi-learn wrote, so a newer release can replace its own older snippet
 *     but never a snippet the learner has customised.
 *   - The snippet is enabled in appearance.json on first install only. After that
 *     Obsidian owns the preference, including the learner turning it off.
 *
 * Pure Node module (no pi imports). Never throws: styling must never stop a lesson.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SNIPPET_NAME = "pi-learn";
const RECEIPT_NAME = "pi-learn-appearance.json";
const SHIPPED_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "styles", "pi-learn.css");

export type StyleStatus = "installed" | "updated" | "current" | "customized" | "no-vault" | "error";

export interface StyleResult {
	status: StyleStatus;
	vaultRoot?: string;
	message?: string;
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Nearest ancestor of `start` (inclusive) that contains an `.obsidian` folder. */
export function findVaultRoot(start: string): string | undefined {
	let dir = resolve(start);
	if (!isDir(dir)) dir = dirname(dir);
	for (;;) {
		if (isDir(join(dir, ".obsidian"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function shippedCss(): string {
	return readFileSync(SHIPPED_CSS_PATH, "utf8");
}

/**
 * Make sure the vault containing `notePath` has the current pi-learn snippet.
 * `css` is injectable for tests; production uses styles/pi-learn.css.
 */
export async function ensureLearnStyle(notePath: string, css?: string): Promise<StyleResult> {
	try {
		const vaultRoot = findVaultRoot(notePath);
		if (!vaultRoot) return { status: "no-vault", message: "No .obsidian folder above the note; styling skipped." };

		const settings = join(vaultRoot, ".obsidian");
		const snippetPath = join(settings, "snippets", `${SNIPPET_NAME}.css`);
		const receiptPath = join(settings, RECEIPT_NAME);
		const appearancePath = join(settings, "appearance.json");

		const shipped = css ?? shippedCss();
		const shippedHash = sha256(shipped);
		const existing = readOptional(snippetPath);
		let receipt: { installedCssSha256?: string } | undefined;
		try {
			const raw = readOptional(receiptPath);
			receipt = raw ? JSON.parse(raw) : undefined;
		} catch {
			receipt = undefined;
		}

		if (existing !== undefined && existing === shipped) {
			if (receipt?.installedCssSha256 !== shippedHash) writeAtomic(receiptPath, `${JSON.stringify({ schemaVersion: 1, installedCssSha256: shippedHash }, null, 2)}\n`);
			return { status: "current", vaultRoot };
		}

		if (existing !== undefined && receipt?.installedCssSha256 !== sha256(existing)) {
			return {
				status: "customized",
				vaultRoot,
				message: `pi-learn left your customised ${SNIPPET_NAME}.css untouched. Delete it (or ${RECEIPT_NAME}) to get the shipped styling, which centers callouts, equations and diagrams.`,
			};
		}

		const firstInstall = existing === undefined && receipt === undefined;
		writeAtomic(snippetPath, shipped);
		writeAtomic(receiptPath, `${JSON.stringify({ schemaVersion: 1, installedCssSha256: shippedHash }, null, 2)}\n`);

		if (firstInstall) {
			const rawAppearance = readOptional(appearancePath);
			let appearance: Record<string, unknown> | undefined;
			try {
				const parsed = rawAppearance === undefined ? {} : JSON.parse(rawAppearance);
				appearance = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
			} catch {
				appearance = undefined;
			}
			if (!appearance) {
				return { status: "installed", vaultRoot, message: `Installed ${SNIPPET_NAME}.css, but appearance.json is not valid JSON; enable the snippet in Settings → Appearance → CSS snippets.` };
			}
			const enabled = Array.isArray(appearance.enabledCssSnippets) ? (appearance.enabledCssSnippets as unknown[]).filter((s) => typeof s === "string") : [];
			if (!enabled.includes(SNIPPET_NAME)) {
				appearance.enabledCssSnippets = [...enabled, SNIPPET_NAME];
				writeAtomic(appearancePath, `${JSON.stringify(appearance, null, 2)}\n`);
			}
			return { status: "installed", vaultRoot };
		}
		return { status: "updated", vaultRoot };
	} catch (error) {
		return { status: "error", message: `pi-learn styling could not be installed: ${error instanceof Error ? error.message : String(error)}` };
	}
}
