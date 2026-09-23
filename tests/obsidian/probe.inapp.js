// In-app probe, evaluated inside the running Obsidian renderer by verify-render.mjs
// through `Obsidian.com vault=<name> eval code=...`. The file evaluates to a single
// async function taking a JSON string of options and returning a plain JSON result
// (the IIFE below returns piLearnRenderProbe; probe() does the work).
//
// Runs with Obsidian's globals (app, require, Buffer, document); keep it plain ES2020
// and self-contained, no imports.
(() => {
	return async function piLearnRenderProbe(optionsJson) {
		// A minimized or fully covered Obsidian window is "hidden": requestAnimationFrame stops, so the
		// reading view never updates its virtualised sections on scroll. Disabling background throttling
		// for the duration of the probe keeps rendering alive without touching the window itself.
		const wcMain = require("electron").remote.getCurrentWebContents();
		const prevThrottle = wcMain.getBackgroundThrottling();
		wcMain.setBackgroundThrottling(false);
		try {
			return await probe(optionsJson);
		} finally {
			wcMain.setBackgroundThrottling(prevThrottle);
		}
	};

async function probe(optionsJson) {
	const opts = JSON.parse(optionsJson);
	const fs = require("fs");
	const nodePath = require("path");
	const { remote } = require("electron");
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	// rAF never fires while the window is occluded ("hidden"), so never wait on it alone
	const frame = () => new Promise((r) => { const t = setTimeout(r, 120); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
	const started = Date.now();
	const notes = [];
	const tolerance = typeof opts.tolerancePx === "number" ? opts.tolerancePx : 2;

	// ---- 0. CSS snippet: enable <vault>/.obsidian/snippets/<name>.css if it exists
	let snippetEnabled = null;
	if (opts.snippet) {
		const cc = app.customCss;
		const snippetFile = cc.getSnippetPath ? cc.getSnippetPath(opts.snippet) : app.vault.configDir + "/snippets/" + opts.snippet + ".css";
		if (await app.vault.adapter.exists(snippetFile)) {
			if (cc.readSnippets) await cc.readSnippets();
			if (!cc.enabledSnippets.has(opts.snippet)) {
				if (opts.enableSnippet === false) notes.push(`snippet "${opts.snippet}" exists but is disabled (--no-enable-snippet)`);
				else {
					cc.setCssEnabledStatus(opts.snippet, true);
					notes.push(`enabled CSS snippet "${opts.snippet}"`);
				}
			}
			if (cc.loadSnippets) await cc.loadSnippets(); // apply now, and pick up edits to the file
			snippetEnabled = cc.enabledSnippets.has(opts.snippet);
		} else {
			snippetEnabled = false;
			notes.push(`snippet file not found: ${snippetFile}`);
		}
	}

	// ---- 1. wait for the vault to see the file and for the metadata cache to be fresh
	const basePath = app.vault.adapter.basePath;
	const diskPath = nodePath.join(basePath, opts.note);
	if (!fs.existsSync(diskPath)) return { note: opts.note, fatal: "file does not exist on disk: " + diskPath };
	const diskStat = fs.statSync(diskPath);
	let file = null;
	for (let t = 0; t < 40; t++) {
		file = app.vault.getAbstractFileByPath(opts.note);
		const meta = file && app.metadataCache.fileCache[file.path];
		if (file && file.stat.size === diskStat.size && meta && meta.mtime === file.stat.mtime && app.metadataCache.getFileCache(file)) break;
		await sleep(125);
	}
	if (!file) return { note: opts.note, fatal: "Obsidian does not know this file (vault not indexed?)" };
	const source = await app.vault.read(file);
	const cache = app.metadataCache.getFileCache(file) || {};

	// ---- 2. open in reading view (reuse one leaf in the main window, never a new window)
	if (opts.trustMermaid && app.loadLocalStorage("mermaid-vault-trust") !== true) {
		app.saveLocalStorage("mermaid-vault-trust", true);
		app.workspace.trigger("post-processor-change");
		notes.push("mermaid-vault-trust set for this vault");
	}
	const win = remote.getCurrentWindow();
	if (win.isMinimized()) notes.push("Obsidian window is minimized; rendering kept alive with background throttling off");
	const modalsBefore = document.querySelectorAll(".modal-container").length;
	let leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit) || app.workspace.getLeaf(false);
	const vt = leaf.view && leaf.view.getViewType ? leaf.view.getViewType() : "";
	if (vt !== "markdown" && vt !== "empty") leaf = app.workspace.getLeaf(false);
	await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview", source: false }, active: true });
	app.workspace.setActiveLeaf(leaf, { focus: false });
	const view = leaf.view;
	if (!view || view.getMode() !== "preview") await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
	const pm = view.previewMode;
	const r = pm.renderer;
	const scroller = r.previewEl;
	pm.rerender(true); // fresh render even if the note was already open (content may have changed on disk)
	scroller.scrollTop = 0;

	// ---- 3. settle: every section rendered, no pending mermaid, DOM signature stable
	const MERMAID_ERROR_RE = /^\s*(Error parsing Mermaid diagram!|Syntax error in text|Mermaid error)/i;
	const sectionEls = () => r.sections.map((s) => s.el).filter(Boolean);
	const qa = (sel) => sectionEls().flatMap((el) => [...el.querySelectorAll(sel)]);
	const mermaidPreBlocks = () => qa("pre.language-mermaid");
	const pendingMermaid = () => mermaidPreBlocks().filter((pre) => !MERMAID_ERROR_RE.test(pre.textContent || "")).length;
	const signature = () => {
		const heights = r.sections.reduce((a, s) => a + (s.height || 0), 0);
		return [r.sections.length, r.sections.filter((s) => s.rendered).length, qa(".mermaid svg").length, mermaidPreBlocks().length, qa("mjx-container").length, heights].join("|");
	};
	let last = "";
	let stableSince = Date.now();
	let settled = false;
	const deadline = Date.now() + (opts.settleMs || 10000);
	await sleep(250);
	while (Date.now() < deadline) {
		const unrendered = r.sections.findIndex((s) => !s.rendered);
		if (unrendered >= 0) {
			// sections far off-screen are rendered lazily: scroll towards them
			const el = r.sections[unrendered].el;
			if (el && el.isConnected) el.scrollIntoView({ block: "start" });
			else scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + scroller.clientHeight);
		}
		await frame();
		await sleep(200);
		const sig = signature();
		if (sig !== last) { last = sig; stableSince = Date.now(); }
		if (unrendered < 0 && pendingMermaid() === 0 && Date.now() - stableSince >= 750) { settled = true; break; }
	}
	scroller.scrollTop = 0;
	await frame();

	// ---- 4. collect (section elements survive virtualisation, so detached ones count too)
	const fenceRe = /^[ \t]*((?:>[ \t]?)*)[ \t]*(```+|~~~+)[ \t]*mermaid\b/gim;
	const mermaidSource = (source.match(fenceRe) || []).length;
	const svgs = qa(".mermaid > svg");
	const errorSvgs = svgs.filter((svg) => svg.getAttribute("aria-roledescription") === "error" || /Syntax error in text/i.test(svg.textContent || ""));
	const errorPres = mermaidPreBlocks().filter((pre) => MERMAID_ERROR_RE.test(pre.textContent || ""));
	const guarded = qa(".mermaid-wrapper.is-guarded").length;
	const lineOf = (el) => {
		const sec = r.getSectionForElement ? r.getSectionForElement(el) : null;
		return sec && sec.start ? sec.start.line + 1 : null;
	};
	const mermaidErrors = [
		...errorPres.map((pre) => ({ line: lineOf(pre), message: (pre.textContent || "").trim().split("\n").filter(Boolean).slice(0, 4).join(" | ") })),
		...errorSvgs.map((svg) => ({ line: lineOf(svg), message: "error diagram: " + (svg.textContent || "").trim().slice(0, 200) })),
	];

	const callouts = {};
	for (const c of qa(".callout[data-callout]")) callouts[c.dataset.callout] = (callouts[c.dataset.callout] || 0) + 1;
	const calloutSource = {};
	for (const m of source.matchAll(/^[ \t]*(?:>[ \t]?)+\[!([^\]\s]+)\][+-]?/gm)) {
		const k = m[1].toLowerCase();
		calloutSource[k] = (calloutSource[k] || 0) + 1;
	}

	// links: the metadata cache is the source of truth, DOM counts are a cross-check
	const norm = (s) => String(s).replace(/[#|^:%\[\]\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
	const unresolvedLinks = [];
	const unresolvedEmbeds = [];
	const brokenSubpaths = [];
	const checkRef = (ref, kind) => {
		const raw = ref.link;
		const hashAt = raw.indexOf("#");
		const linkPath = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
		const subpath = hashAt >= 0 ? raw.slice(hashAt) : "";
		const target = linkPath ? app.metadataCache.getFirstLinkpathDest(linkPath, file.path) : file;
		const where = ref.position ? ref.position.start.line + 1 : null;
		if (!target) {
			(kind === "embed" ? unresolvedEmbeds : unresolvedLinks).push({ link: raw, line: where });
			return;
		}
		if (!subpath || target.extension !== "md") return;
		const tcache = app.metadataCache.getFileCache(target) || {};
		if (subpath.startsWith("#^")) {
			const id = subpath.slice(2).toLowerCase();
			if (!tcache.blocks || !tcache.blocks[id]) brokenSubpaths.push({ link: raw, line: where, reason: "block not found in " + target.path });
			return;
		}
		const parts = subpath.split("#").filter(Boolean).map(norm);
		const headings = (tcache.headings || []).map((h) => norm(h.heading));
		let idx = -1;
		const ok = parts.every((p) => { idx = headings.indexOf(p, idx + 1); return idx >= 0; });
		if (!ok) brokenSubpaths.push({ link: raw, line: where, reason: "heading not found in " + target.path });
	};
	for (const l of cache.links || []) checkRef(l, "link");
	for (const e of cache.embeds || []) checkRef(e, "embed");
	for (const l of cache.frontmatterLinks || []) checkRef(l, "link");

	// ---- 5. one scroll pass over the reading view: measure centering, capture screenshots
	const contentBox = (el) => {
		const b = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		const px = (v) => parseFloat(v) || 0;
		return { left: b.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), right: b.right - px(cs.borderRightWidth) - px(cs.paddingRight) };
	};
	const columnFor = (el) => {
		const inCallout = el.parentElement && el.parentElement.closest(".callout-content");
		return inCallout || el.closest(".markdown-preview-sizer") || el.parentElement;
	};
	const centering = new Map(); // element -> record
	const measureCentering = () => {
		const targets = [
			...[...scroller.querySelectorAll(".mermaid > svg")].map((el) => ["mermaid", el, el]),
			...[...scroller.querySelectorAll(".callout")].filter((el) => !el.parentElement.closest(".callout")).map((el) => ["callouts", el, el]),
			// the visible formula is the inner mjx-math; mjx-container itself is a full-width block
			...[...scroller.querySelectorAll('mjx-container[display="true"]')].map((el) => ["math", el, el.querySelector(":scope > mjx-math") || el]),
		];
		for (const [kind, key, el] of targets) {
			if (centering.has(key) || !el.isConnected) continue;
			const b = el.getBoundingClientRect();
			if (b.width < 1) continue;
			const col = contentBox(columnFor(key));
			const offset = (b.left + b.right) / 2 - (col.left + col.right) / 2;
			centering.set(key, {
				kind,
				line: lineOf(key),
				offsetPx: Math.round(offset * 10) / 10,
				width: Math.round(b.width),
				columnWidth: Math.round(col.right - col.left),
				inCallout: !!(key.parentElement && key.parentElement.closest(".callout-content")),
				label: kind === "callouts" ? key.dataset.callout : kind === "mermaid" ? key.getAttribute("aria-roledescription") || "" : "",
			});
		}
	};
	const shots = [];
	let canvas = null, ctx = null, scale = 1, rect = null, wc = null, maxPx = 30000, attachedByUs = false;
	const hiddenEls = [];
	// webContents.capturePage() returns a STALE frame when the window is occluded (document hidden);
	// CDP Page.captureScreenshot always composites a fresh frame, so prefer it.
	const capture = async () => {
		if (wc.debugger.isAttached()) {
			const res = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
			return createImageBitmap(new Blob([Buffer.from(res.data, "base64")], { type: "image/png" }));
		}
		return createImageBitmap(new Blob([(await wc.capturePage({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })).toPNG()], { type: "image/png" }));
	};
	if (opts.outDir) {
		try {
			wc = remote.getCurrentWebContents();
			if (!wc.debugger.isAttached()) {
				try { wc.debugger.attach("1.3"); attachedByUs = true; } catch (e) { notes.push("CDP unavailable (" + e.message + "); using capturePage, which can be stale if the window is covered"); }
			}
			for (const el of document.querySelectorAll(".status-bar")) { hiddenEls.push([el, el.style.visibility]); el.style.visibility = "hidden"; }
			fs.mkdirSync(opts.outDir, { recursive: true });
			const vr = scroller.getBoundingClientRect();
			// start 1px below the scroller's top edge so the view header's border never lands in the stitch
			const y0 = Math.max(0, Math.ceil(vr.top) + 1);
			rect = {
				x: Math.max(0, Math.ceil(vr.left)),
				y: y0,
				width: Math.floor(Math.min(vr.right, window.innerWidth) - Math.max(0, Math.ceil(vr.left))),
				height: Math.floor(Math.min(vr.bottom, window.innerHeight) - y0),
			};
			rect.offsetY = y0 - vr.top;
			const first = await capture();
			scale = first.width / rect.width;
			canvas = document.createElement("canvas");
			canvas.width = first.width;
			canvas.height = Math.min(Math.ceil(scroller.scrollHeight * scale), maxPx);
			ctx = canvas.getContext("2d");
			// paint the page background first so rounding gaps between captures never show as white lines
			let bg = getComputedStyle(scroller).backgroundColor;
			if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = getComputedStyle(document.body).backgroundColor || "#1e1e1e";
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		} catch (e) {
			notes.push("screenshot setup failed: " + (e && e.message ? e.message : String(e)));
			canvas = null;
		}
	}
	const blocks = new Map(); // mermaid block element -> page-relative box, for per-diagram crops
	const noteBlocks = () => {
		const sr = scroller.getBoundingClientRect();
		for (const el of scroller.querySelectorAll(".mermaid, pre.language-mermaid, .mermaid-wrapper")) {
			if (blocks.has(el)) continue;
			const b = el.getBoundingClientRect();
			if (b.height < 2) continue;
			const kind = el.matches(".mermaid") ? "diagram" : el.matches(".mermaid-wrapper") ? "guarded" : "error";
			blocks.set(el, { top: b.top - sr.top + scroller.scrollTop, left: b.left - sr.left, width: b.width, height: b.height, kind });
		}
	};
	const step = Math.max(100, canvas && rect ? rect.height - 2 : scroller.clientHeight);
	for (let top = 0; ; top += step) {
		scroller.scrollTop = top;
		await frame();
		await sleep(top === 0 ? 150 : 350);
		for (let t = 0; t < 20 && pendingMermaid() > 0; t++) await sleep(150);
		const actual = scroller.scrollTop;
		measureCentering();
		noteBlocks();
		if (canvas && (actual + rect.offsetY) * scale < canvas.height) {
			try {
				const bmp = await capture();
				ctx.drawImage(bmp, 0, Math.round((actual + rect.offsetY) * scale));
			} catch (e) {
				notes.push("capture failed at scrollTop " + actual + ": " + e.message);
				canvas = null;
			}
		}
		if (actual + scroller.clientHeight >= scroller.scrollHeight - 1 || actual < top - step || top > 400000) break;
	}
	scroller.scrollTop = 0;
	for (const [el, v] of hiddenEls) el.style.visibility = v;
	if (attachedByUs) { try { wc.debugger.detach(); } catch {} }
	if (canvas) {
		const save = async (cv, name) => {
			const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
			const out = nodePath.join(opts.outDir, name);
			fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
			shots.push(out);
		};
		await save(canvas, opts.slug + ".png");
		if (scroller.scrollHeight * scale > maxPx) notes.push("full-page screenshot truncated at " + maxPx + "px");
		let n = 0;
		for (const b of [...blocks.values()].sort((a, c) => a.top - c.top)) {
			n++;
			const sx = Math.max(0, Math.floor((b.left - 8) * scale));
			const sy = Math.max(0, Math.floor((b.top - 8) * scale));
			const sw = Math.min(canvas.width - sx, Math.ceil((b.width + 16) * scale));
			const sh = Math.min(canvas.height - sy, Math.ceil((b.height + 16) * scale));
			if (sw <= 0 || sh <= 0) continue;
			const crop = document.createElement("canvas");
			crop.width = sw;
			crop.height = sh;
			crop.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
			await save(crop, `${opts.slug}.mermaid-${n}-${b.kind}.png`);
		}
	}

	const centerSummary = { tolerancePx: tolerance, mermaid: { total: 0, centered: 0 }, callouts: { total: 0, centered: 0 }, math: { total: 0, centered: 0 }, offenders: [] };
	for (const rec of centering.values()) {
		const bucket = centerSummary[rec.kind];
		bucket.total++;
		if (Math.abs(rec.offsetPx) <= tolerance) bucket.centered++;
		else centerSummary.offenders.push(rec);
	}
	// elements never attached during the pass cannot be measured: report them
	const expected = { mermaid: svgs.length, callouts: qa(".callout").filter((c) => !c.parentElement.closest(".callout")).length, math: qa('mjx-container[display="true"]').length };
	for (const k of Object.keys(expected)) if (expected[k] !== centerSummary[k].total) centerSummary[k].unmeasured = expected[k] - centerSummary[k].total;

	const frontmatterPresent = /^---\r?\n/.test(source);
	const renderedText = sectionEls().map((el) => el.textContent || "").join("\n");
	const mathAll = qa("mjx-container");
	const fmClasses = cache.frontmatter ? [].concat(cache.frontmatter.cssclasses || cache.frontmatter.cssclass || []) : [];
	const result = {
		note: file.path,
		settled,
		settleMs: Date.now() - started,
		mode: view.getMode(),
		snippetEnabled,
		cssclasses: { frontmatter: fmClasses, applied: fmClasses.filter((c) => scroller.classList.contains(c)) },
		mermaid: {
			source: mermaidSource,
			rendered: svgs.length - errorSvgs.length,
			errors: mermaidErrors.length,
			guarded,
			pending: pendingMermaid(),
			errorMessages: mermaidErrors,
		},
		callouts,
		calloutSource,
		links: {
			unresolved: unresolvedLinks,
			unresolvedEmbeds,
			brokenSubpaths,
			metadataUnresolved: app.metadataCache.unresolvedLinks[file.path] || {},
			domUnresolved: qa("a.internal-link.is-unresolved").map((a) => a.getAttribute("data-href") || a.textContent),
			domUnresolvedEmbeds: qa(".internal-embed.is-unresolved, .file-embed.mod-empty").length,
		},
		frontmatter: {
			present: frontmatterPresent,
			parsed: !!cache.frontmatter,
			keys: cache.frontmatter ? Object.keys(cache.frontmatter) : [],
			propertiesShown: qa(".metadata-property").length,
		},
		math: {
			rendered: mathAll.length,
			display: mathAll.filter((m) => m.getAttribute("display") === "true").length,
			errors: qa("mjx-merror").length,
		},
		centering: centerSummary,
		commentLeaks: (renderedText.match(/%%/g) || []).length,
		headings: (cache.headings || []).map((h) => h.heading),
		notes,
		screenshots: shots,
	};

	// ---- 6. never leave dialogs behind
	const modals = [...document.querySelectorAll(".modal-container")];
	if (modals.length > modalsBefore) {
		for (const m of modals.slice(modalsBefore)) {
			const close = m.querySelector(".modal-close-button");
			if (close) close.click();
		}
		notes.push("closed " + (modals.length - modalsBefore) + " dialog(s) that appeared during the check");
	}
	result.openDialogs = document.querySelectorAll(".modal-container").length;
	return result;
}
})()
