import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CommonsImageError,
	importCommonsImage,
	previewCommonsImage,
	searchCommonsImages,
} from "../../extensions/lib/commons-images.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
const SHA1 = "a".repeat(40);

function page(overrides = {}) {
	return {
		pageid: 123,
		title: "File:Test image.png",
		index: 1,
		imageinfo: [{
			mime: "image/png", sha1: SHA1, size: PNG.length,
			url: "https://upload.wikimedia.org/wikipedia/commons/test.png",
			thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/test.png",
			extmetadata: {
			Artist: { value: '<a href="//commons.wikimedia.org">Jane &amp; Joe</a>' },
			LicenseShortName: { value: "CC BY-SA 4.0" },
			LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
			},
		}],
		...overrides,
	};
}

function api(data) {
	return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function png(headers = {}) {
	return new Response(PNG, { status: 200, headers: { "content-type": "image/png", ...headers } });
}

function fakeNetwork({ searchPages = [page()], freshPage = page(), imageResponse = () => png() } = {}) {
	const calls = [];
	const fetchImpl = async (input, init) => {
		const url = new URL(String(input));
		calls.push({ url, init });
		if (url.hostname === "commons.wikimedia.org") {
			if (url.searchParams.has("generator")) return api({ query: { pages: searchPages } });
			return api({ query: { pages: [freshPage] } });
		}
		if (url.hostname === "thumb.wikimedia.org") return typeof imageResponse === "function" ? imageResponse() : imageResponse;
		throw new Error(`unexpected host: ${url.hostname}`);
	};
	return { fetchImpl, calls };
}

test("search uses Commons file namespace, relevance order, raster and license filters", async () => {
	const valid = page();
	const newer = page({ pageid: 456, title: "File:Another.png", index: 2 });
	const svg = page({ pageid: 789, title: "File:Vector.svg", index: 3, imageinfo: [{ ...page().imageinfo[0], mime: "image/svg+xml" }] });
	const unlicensed = page({ pageid: 999, title: "File:Unknown.png", index: 4, imageinfo: [{ ...page().imageinfo[0], extmetadata: {} }] });
	const badHost = page({ pageid: 998, title: "File:Bad.png", index: 5, imageinfo: [{ ...page().imageinfo[0], thumburl: "https://evil.example/bad.png" }] });
	const nonCommercial = page({ pageid: 997, title: "File:NC.png", index: 6, imageinfo: [{ ...page().imageinfo[0], extmetadata: { ...page().imageinfo[0].extmetadata, LicenseShortName: { value: "CC BY-NC 4.0" } } }] });
	const network = fakeNetwork({ searchPages: [badHost, newer, svg, unlicensed, nonCommercial, valid] });
	const result = await searchCommonsImages("  blood glucose microscope  ", { fetchImpl: network.fetchImpl, limit: 4 });
	assert.deepEqual(result.map((c) => c.id), ["123", "456"]);
	assert.equal(result[0].artist, "Jane & Joe");
	assert.equal(result[0].license, "CC BY-SA 4.0");
	const url = network.calls[0].url;
	assert.equal(url.searchParams.get("generator"), "search");
	assert.equal(url.searchParams.get("gsrnamespace"), "6");
	assert.equal(url.searchParams.get("gsrsearch"), "blood glucose microscope");
	assert.equal(network.calls[0].init.redirect, "error");
});

test("search rejects bad queries and handles an offline Commons API", async () => {
	await assert.rejects(searchCommonsImages("x\nother"), /short, plain-language/);
	await assert.rejects(searchCommonsImages("x".repeat(121)), /120 characters/);
	await assert.rejects(
		searchCommonsImages("glucose", { fetchImpl: async () => { throw new Error("offline"); } }),
		(error) => error instanceof CommonsImageError && /unavailable/.test(error.message),
	);
});

test("preview accepts a bounded raster and rejects unsafe redirects and MIME lies", async () => {
	const candidate = (await searchCommonsImages("test", { fetchImpl: fakeNetwork().fetchImpl }))[0];
	const preview = await previewCommonsImage(candidate, fakeNetwork().fetchImpl);
	assert.equal(preview.mimeType, "image/png");
	assert.deepEqual(Buffer.from(preview.data, "base64"), PNG);
	const redirect = fakeNetwork({ imageResponse: () => new Response(null, { status: 302, headers: { location: "https://evil.example/image.png" } }) });
	await assert.rejects(previewCommonsImage(candidate, redirect.fetchImpl), /outside Wikimedia/);
	const lie = fakeNetwork({ imageResponse: () => new Response("<svg/>", { headers: { "content-type": "image/png" } }) });
	await assert.rejects(previewCommonsImage(candidate, lie.fetchImpl), /does not match its MIME/);
	const tooBig = fakeNetwork({ imageResponse: () => png({ "content-length": "99999999" }) });
	await assert.rejects(previewCommonsImage(candidate, tooBig.fetchImpl), /exceeds/);
});

test("import writes a local vault image and stable embed with attribution, then reuses it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-commons-"));
	mkdirSync(join(root, ".obsidian"));
	mkdirSync(join(root, "Learn"));
	const note = join(root, "Learn", "A lesson.md");
	writeFileSync(note, "# A lesson\n");
	const network = fakeNetwork();
	const candidate = (await searchCommonsImages("test", { fetchImpl: network.fetchImpl }))[0];
	const options = { cwd: join(root, "Learn"), linkedNote: note, fetchImpl: network.fetchImpl };
	const first = await importCommonsImage(candidate, options);
	assert.equal(first.reused, false);
	assert.match(first.embed, /^!\[\[pi-learn-images\/commons-123-[a-f0-9]{20}\.png\|500\]\]$/);
	assert.deepEqual(readFileSync(first.path), PNG);
	assert.match(first.attribution, /Jane & Joe/);
	assert.match(first.attribution, /CC BY-SA 4\.0/);
	assert.match(first.attribution, /Source on Wikimedia Commons/);
	const second = await importCommonsImage(candidate, options);
	assert.equal(second.path, first.path);
	assert.equal(second.embed, first.embed);
	assert.equal(second.reused, true);
	assert.equal(createHash("sha256").update(readFileSync(first.path)).digest("hex"), createHash("sha256").update(PNG).digest("hex"));
});

test("import rejects changed files and non-vault destinations", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-learn-commons-no-vault-"));
	const vault = mkdtempSync(join(tmpdir(), "pi-learn-commons-vault-"));
	mkdirSync(join(vault, ".obsidian"));
	const network = fakeNetwork();
	const candidate = (await searchCommonsImages("test", { fetchImpl: network.fetchImpl }))[0];
	const changed = fakeNetwork({ freshPage: page({ imageinfo: [{ ...page().imageinfo[0], sha1: "b".repeat(40) }] }) });
	await assert.rejects(importCommonsImage(candidate, { cwd: vault, fetchImpl: changed.fetchImpl }), /changed since the search/);
	await assert.rejects(importCommonsImage(candidate, { cwd: root, fetchImpl: network.fetchImpl }), /inside an Obsidian vault/);
});

test("import refuses an existing non-file at its destination", async () => {
	const vault = mkdtempSync(join(tmpdir(), "pi-learn-commons-collision-"));
	mkdirSync(join(vault, ".obsidian"));
	const network = fakeNetwork();
	const candidate = (await searchCommonsImages("test", { fetchImpl: network.fetchImpl }))[0];
	const digest = createHash("sha256").update(PNG).digest("hex").slice(0, 20);
	mkdirSync(join(vault, "pi-learn-images", `commons-123-${digest}.png`), { recursive: true });
	await assert.rejects(importCommonsImage(candidate, { cwd: vault, fetchImpl: network.fetchImpl }), /not a regular file/);
});
