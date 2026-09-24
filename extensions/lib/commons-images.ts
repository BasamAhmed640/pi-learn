/** Wikimedia Commons image search and bounded vault import. No pi dependencies. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const API = "https://commons.wikimedia.org/w/api.php";
const IMAGE_HOSTS = new Set(["thumb.wikimedia.org", "upload.wikimedia.org"]);
const RASTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const API_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
const USER_AGENT = "pi-learn/0.2 (educational Wikimedia Commons image import)";

export class CommonsImageError extends Error {}

export interface CommonsCandidate {
	id: string;
	title: string;
	pageId: number;
	sha1: string;
	mime: string;
	previewUrl: string;
	sourceUrl: string;
	artist: string;
	license: string;
	licenseUrl: string | null;
}

export interface ImportedCommonsImage {
	path: string;
	embed: string;
	attribution: string;
	bytes: number;
	reused: boolean;
}

type Fetcher = typeof fetch;

function fail(message: string): never {
	throw new CommonsImageError(message);
}

function cleanText(value: unknown, max = 240): string {
	let text = String(value ?? "")
		.replace(/<br\s*\/?\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (m) => ({
			"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
		})[m.toLowerCase()] ?? m)
		.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length > max) text = text.slice(0, max - 1).trimEnd() + "…";
	return text;
}

function markdownText(value: string): string {
	return value.replace(/[\\`*_{}\[\]()<>|]/g, "\\$&");
}

function safeHttpsUrl(value: unknown): string | null {
	try {
		const url = new URL(String(value));
		if (url.protocol !== "https:" || url.username || url.password || /[<>]/.test(url.href)) return null;
		return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
	} catch {
		return null;
	}
}

function imageUrl(value: unknown): string {
	const safe = safeHttpsUrl(value);
	if (!safe || !IMAGE_HOSTS.has(new URL(safe).hostname)) fail("Commons returned an image URL outside Wikimedia's image hosts.");
	return safe;
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
	const stated = Number(response.headers.get("content-length"));
	if (Number.isFinite(stated) && stated > maxBytes) fail(`Image exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
	if (!response.body) fail("The image response had no body.");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) fail(`Image exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
			chunks.push(Buffer.from(value));
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks, size);
}

async function apiQuery(params: Record<string, string>, fetchImpl: Fetcher): Promise<any> {
	const url = new URL(API);
	for (const [key, value] of Object.entries({ action: "query", format: "json", formatversion: "2", ...params })) {
		url.searchParams.set(key, value);
	}
	let response: Response;
	try {
		response = await fetchImpl(url, { redirect: "error", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });
	} catch {
		fail("Wikimedia Commons is unavailable. Continue the lesson without a web image.");
	}
	if (!response.ok) fail(`Wikimedia Commons returned HTTP ${response.status}. Continue without a web image.`);
	try {
		return JSON.parse((await boundedBody(response, API_BYTES)).toString("utf8"));
	} catch (error) {
		if (error instanceof CommonsImageError) throw error;
		fail("Wikimedia Commons returned an unreadable search response.");
	}
}

function candidateOf(page: any): CommonsCandidate | null {
	const info = page?.imageinfo?.[0];
	if (!Number.isSafeInteger(page?.pageid) || page.pageid <= 0 || !/^File:/i.test(page?.title ?? "")) return null;
	if (!info || !RASTER_MIMES.has(info.mime) || !/^[a-f0-9]{40}$/i.test(info.sha1 ?? "")) return null;
	const meta = info.extmetadata ?? {};
	const license = cleanText(meta.LicenseShortName?.value, 100);
	if (!/^(?:CC0|CC BY(?:-SA)?|Public domain|PD)(?:\s|$)/i.test(license)) return null;
	const artist = cleanText(meta.Artist?.value, 300);
	if (!artist || /^(?:unknown|anonymous|not (?:stated|provided|known)|n\/a|none|\?)$/i.test(artist)) return null;
	const licenseUrl = safeHttpsUrl(meta.LicenseUrl?.value);
	if (/^CC/i.test(license) && !licenseUrl) return null;
	const previewUrl = safeHttpsUrl(info.thumburl || info.url);
	if (!previewUrl || !IMAGE_HOSTS.has(new URL(previewUrl).hostname)) return null;
	const encodedTitle = encodeURIComponent(page.title.slice(5).replace(/ /g, "_"))
		.replace(/\(/g, "%28").replace(/\)/g, "%29");
	const sourceUrl = `https://commons.wikimedia.org/wiki/File:${encodedTitle}`;
	return {
		id: String(page.pageid), title: page.title, pageId: page.pageid, sha1: info.sha1.toLowerCase(),
		mime: info.mime, previewUrl, sourceUrl,
		artist,
		license, licenseUrl,
	};
}

export async function searchCommonsImages(query: string, options: { fetchImpl?: Fetcher; limit?: number } = {}): Promise<CommonsCandidate[]> {
	query = String(query ?? "").trim();
	if (!query || query.length > 120 || /[\x00-\x1f\x7f]/.test(query)) fail("Use a short, plain-language image search (1–120 characters).");
	const requested = Number(options.limit ?? 4);
	const limit = Number.isFinite(requested) ? Math.max(1, Math.min(5, Math.floor(requested))) : 4;
	const data = await apiQuery({
		generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: String(Math.max(10, limit * 3)),
		prop: "imageinfo", iiprop: "url|size|mime|sha1|extmetadata|thumbmime", iiurlwidth: "320",
	}, options.fetchImpl ?? fetch);
	const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
	return pages.sort((a: any, b: any) => (a.index ?? Infinity) - (b.index ?? Infinity))
		.map(candidateOf).filter((c: CommonsCandidate | null): c is CommonsCandidate => !!c).slice(0, limit);
}

function sniffMime(bytes: Buffer): string | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return null;
}

async function downloadImage(url: string, maxBytes: number, fetchImpl: Fetcher): Promise<{ bytes: Buffer; mime: string }> {
	let current = imageUrl(url);
	for (let redirects = 0; redirects <= 2; redirects++) {
		let response: Response;
		try {
			response = await fetchImpl(current, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
		} catch {
			fail("The Commons image could not be downloaded. Continue without it.");
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => {});
			if (!location) fail("The Commons image redirected without a destination.");
			current = imageUrl(new URL(location, current).href);
			continue;
		}
		if (!response.ok) fail(`The Commons image returned HTTP ${response.status}.`);
		const declared = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
		if (!RASTER_MIMES.has(declared)) fail("Commons returned a non-raster image format.");
		const bytes = await boundedBody(response, maxBytes);
		const actual = sniffMime(bytes);
		if (!actual || actual !== declared) fail("The downloaded image content does not match its MIME type.");
		return { bytes, mime: actual };
	}
	fail("The Commons image redirected too many times.");
}

export async function previewCommonsImage(candidate: CommonsCandidate, fetchImpl: Fetcher = fetch): Promise<{ data: string; mimeType: string }> {
	const { bytes, mime } = await downloadImage(candidate.previewUrl, MAX_PREVIEW_BYTES, fetchImpl);
	return { data: bytes.toString("base64"), mimeType: mime };
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findVaultRoot(start: string): string {
	let dir = realpathSync(start);
	for (;;) {
		if (existsSync(join(dir, ".obsidian")) && statSync(join(dir, ".obsidian")).isDirectory()) return dir;
		const parent = dirname(dir);
		if (parent === dir) fail("Start the lesson inside an Obsidian vault before importing an image.");
		dir = parent;
	}
}

function attribution(candidate: CommonsCandidate): string {
	const title = markdownText(cleanText(candidate.title.replace(/^File:/i, ""), 180));
	const artist = markdownText(candidate.artist);
	const license = markdownText(candidate.license);
	const licenseLink = candidate.licenseUrl ? `[${license}](${candidate.licenseUrl})` : license;
	return `Image: “${title}” (Wikimedia thumbnail) by ${artist}, ${licenseLink}. [Source on Wikimedia Commons](${candidate.sourceUrl}).`;
}

export async function importCommonsImage(
	candidate: CommonsCandidate,
	options: { cwd: string; linkedNote?: string | null; altText: string; fetchImpl?: Fetcher },
): Promise<ImportedCommonsImage> {
	const altText = typeof options.altText === "string" ? options.altText.trim() : "";
	if (altText.length < 8 || altText.length > 240 || /[\x00-\x1f\x7f]/.test(altText)) {
		fail("Describe what the image conveys in alt text before importing it.");
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const base = options.linkedNote && existsSync(options.linkedNote) ? dirname(resolve(options.linkedNote)) : resolve(options.cwd);
	const vaultRoot = findVaultRoot(base);
	const data = await apiQuery({ titles: candidate.title, prop: "imageinfo", iiprop: "url|size|mime|sha1|extmetadata|thumbmime", iiurlwidth: "1200" }, fetchImpl);
	const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
	const fresh = pages.length === 1 ? candidateOf(pages[0]) : null;
	if (!fresh || fresh.pageId !== candidate.pageId || fresh.sha1 !== candidate.sha1 || fresh.title !== candidate.title) {
		fail("This Commons file changed since the search. Search again before importing it.");
	}
	const info = pages[0].imageinfo[0];
	const image = info.thumburl || (info.size <= MAX_IMAGE_BYTES ? info.url : null);
	if (!image) fail("Commons has no bounded raster version of this image.");
	const width = Number(info.thumbwidth || info.width);
	const height = Number(info.thumbheight || info.height);
	if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width * height > 12_000_000) {
		fail("The Commons image has too many pixels for a lesson embed.");
	}
	const { bytes, mime } = await downloadImage(image, MAX_IMAGE_BYTES, fetchImpl);
	const assets = join(vaultRoot, "pi-learn-images");
	mkdirSync(assets, { recursive: true });
	const realAssets = realpathSync(assets);
	if (!inside(vaultRoot, realAssets)) fail("The vault image folder resolves outside the vault.");
	const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
	const filename = `commons-${candidate.id}-${digest}.${EXTENSIONS[mime]}`;
	const dest = join(realAssets, filename);
	if (!inside(vaultRoot, dest)) fail("The image destination is outside the vault.");
	let reused = false;
	try {
		writeFileSync(dest, bytes, { flag: "wx" });
	} catch (error: any) {
		if (error?.code !== "EEXIST") throw error;
		if (!lstatSync(dest).isFile() || !inside(vaultRoot, realpathSync(dest))) {
			fail("The existing vault image is not a regular file inside the vault.");
		}
		const existing = readFileSync(dest);
		if (!existing.equals(bytes)) fail("The existing vault image differs from the selected Commons file.");
		reused = true;
	}
	// A Markdown image gives screen readers a description; the path is relative to the linked note.
	const noteDir = options.linkedNote && existsSync(options.linkedNote) ? dirname(resolve(options.linkedNote)) : resolve(options.cwd);
	const imagePath = relative(noteDir, dest).split(sep).join("/");
	return { path: dest, embed: `![${markdownText(altText)}](<${imagePath}>)`, attribution: attribution(fresh), bytes: bytes.length, reused };
}
