#!/usr/bin/env node
// Verifies how Markdown notes ACTUALLY render inside the running Obsidian desktop app.
//
//   node tests/obsidian/verify-render.mjs --vault <name|path> --notes <a.md,b.md|folder> [--out <dir>]
//
// For each note it drives Obsidian through its CLI (`Obsidian.com ... eval code=...`), opens the
// note in reading view, waits until rendering settles, then reports Mermaid / callout / link /
// frontmatter / math / centering results as JSON and saves screenshots. Exit code 1 when any
// problem is found, 2 on usage or connection errors. See tests/obsidian/README.md.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, "probe.inapp.js");

function usage(msg) {
	if (msg) console.error("error: " + msg);
	console.error(`usage: node tests/obsidian/verify-render.mjs --vault <name|path> --notes <paths,comma,separated|folder> [options]

  --vault <name|path>     vault name (as in "Obsidian.com vaults") or its folder path
  --notes <list|folder>   note paths relative to the vault, comma-separated, or a vault folder
  --out <dir>             write screenshots and report.json here (default: no screenshots)
  --snippet <name>        CSS snippet to enable if <vault>/.obsidian/snippets/<name>.css exists (default: pi-learn; "none" to skip)
  --no-enable-snippet     report the snippet state but do not enable it
  --trust-mermaid         allow Mermaid in this vault (Obsidian 1.13 guards Mermaid behind a per-vault "Allow")
  --tolerance <px>        centering tolerance in px (default 2)
  --settle <ms>           max wait for rendering to settle per note (default 10000)
  --obsidian <path>       path to Obsidian.com (default: %LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.com)
  --json                  print only the JSON report`);
	process.exit(2);
}

function parseArgs(argv) {
	const o = { snippet: "pi-learn", enableSnippet: true, trustMermaid: false, tolerance: 2, settle: 10000, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
		if (a === "--vault") o.vault = val();
		else if (a === "--notes") o.notes = val();
		else if (a === "--out") o.out = val();
		else if (a === "--snippet") o.snippet = val();
		else if (a === "--no-enable-snippet") o.enableSnippet = false;
		else if (a === "--trust-mermaid") o.trustMermaid = true;
		else if (a === "--tolerance") o.tolerance = Number(val());
		else if (a === "--settle") o.settle = Number(val());
		else if (a === "--obsidian") o.obsidian = val();
		else if (a === "--json") o.json = true;
		else if (a === "-h" || a === "--help") usage();
		else usage(`unknown argument ${a}`);
	}
	if (!o.vault || !o.notes) usage("--vault and --notes are required");
	if (o.snippet === "none") o.snippet = null;
	return o;
}

function findCli(explicit) {
	const candidates = [
		explicit,
		process.env.OBSIDIAN_CLI,
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"),
	].filter(Boolean);
	for (const c of candidates) if (existsSync(c)) return c;
	usage("Obsidian.com not found; pass --obsidian <path>");
}

// Obsidian.com prints "=> <value>" on success (objects as JSON), "Error: ..." on a thrown error,
// and forwards console errors raised during the eval as "[error] ..." lines before the value.
function cli(exe, args, { timeout = 120000 } = {}) {
	const res = spawnSync(exe, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
	if (res.error) throw new Error(`Obsidian CLI failed: ${res.error.message}`);
	return (res.stdout || "") + (res.stderr || "");
}

function evalInApp(exe, vaultName, code, opts) {
	const out = cli(exe, [`vault=${vaultName}`, "eval", `code=${code}`], opts);
	const at = out.startsWith("=> ") ? 0 : out.indexOf("\n=> ") + 1;
	if (at <= 0 && !out.startsWith("=> ")) throw new Error(out.trim() || "empty response from Obsidian CLI");
	const payload = out.slice(at + 3).trim();
	try {
		return JSON.parse(payload);
	} catch {
		return payload;
	}
}

function loadVaultRegistry() {
	const p = join(process.env.APPDATA || "", "obsidian", "obsidian.json");
	if (!existsSync(p)) return [];
	const j = JSON.parse(readFileSync(p, "utf8"));
	return Object.values(j.vaults || {}).map((v) => ({ path: v.path, name: basename(v.path) }));
}

function resolveVault(arg) {
	const reg = loadVaultRegistry();
	const asPath = resolve(arg);
	const byPath = reg.find((v) => resolve(v.path).toLowerCase() === asPath.toLowerCase());
	if (byPath) return byPath;
	const byName = reg.filter((v) => v.name === arg);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) usage(`several registered vaults are named "${arg}"; pass the vault path instead`);
	if (existsSync(asPath) && existsSync(join(asPath, ".obsidian"))) return { path: asPath, name: basename(asPath) };
	usage(`vault "${arg}" is not registered in obsidian.json`);
}

function listNotes(vaultPath, spec) {
	const out = [];
	const walk = (abs) => {
		for (const name of readdirSync(abs).sort()) {
			if (name.startsWith(".")) continue;
			const p = join(abs, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.toLowerCase().endsWith(".md")) out.push(relative(vaultPath, p).split(sep).join("/"));
		}
	};
	for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
		const rel = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const abs = join(vaultPath, rel);
		if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
		else out.push(rel);
	}
	return [...new Set(out)];
}

function problemsOf(r, o) {
	const p = [];
	if (r.fatal) return [r.fatal];
	if (!r.settled) p.push("rendering did not settle within the time limit");
	if (r.mode !== "preview") p.push(`note is in ${r.mode} mode, not reading view`);
	const m = r.mermaid;
	if (m.errors) p.push(`${m.errors} Mermaid error(s): ` + m.errorMessages.map((e) => `line ${e.line}: ${e.message}`).join(" || "));
	if (m.guarded) p.push(`${m.guarded} Mermaid block(s) blocked by Obsidian's "Display Mermaid diagrams in this vault?" guard (use --trust-mermaid)`);
	if (m.pending) p.push(`${m.pending} Mermaid block(s) never rendered`);
	if (m.rendered + m.errors + m.guarded + m.pending !== m.source) p.push(`Mermaid source has ${m.source} block(s) but ${m.rendered} rendered + ${m.errors} errored`);
	for (const l of r.links.unresolved) p.push(`unresolved link [[${l.link}]] (line ${l.line})`);
	for (const l of r.links.unresolvedEmbeds) p.push(`unresolved embed ![[${l.link}]] (line ${l.line})`);
	for (const l of r.links.brokenSubpaths) p.push(`broken link [[${l.link}]] (line ${l.line}): ${l.reason}`);
	if (r.frontmatter.present && !r.frontmatter.parsed) p.push("frontmatter present but Obsidian could not parse it");
	if (r.math.errors) p.push(`${r.math.errors} MathJax error(s)`);
	if (r.commentLeaks) p.push(`"%%" visible in rendered text (${r.commentLeaks}x): a comment did not close`);
	for (const [type, n] of Object.entries(r.calloutSource)) {
		if ((r.callouts[type] || 0) < n) p.push(`callout [!${type}]: ${n} in source, ${r.callouts[type] || 0} rendered`);
	}
	const c = r.centering;
	for (const k of ["mermaid", "callouts", "math"]) {
		if (c[k].unmeasured) p.push(`${c[k].unmeasured} ${k} element(s) could not be measured for centering`);
	}
	for (const off of c.offenders) p.push(`not centered: ${off.kind}${off.label ? " " + off.label : ""} (line ${off.line}) is ${off.offsetPx}px off-center`);
	if (o.snippet && r.snippetEnabled === false) p.push(`CSS snippet "${o.snippet}" is not enabled`);
	if (r.openDialogs) p.push(`${r.openDialogs} dialog(s) open in Obsidian`);
	return p;
}

function main() {
	const o = parseArgs(process.argv.slice(2));
	const exe = findCli(o.obsidian);
	const vault = resolveVault(o.vault);
	const notes = listNotes(vault.path, o.notes);
	if (!notes.length) usage(`no notes matched "${o.notes}" in ${vault.path}`);
	const outDir = o.out ? resolve(o.out) : null;
	if (outDir) mkdirSync(outDir, { recursive: true });

	const ping = cli(exe, [`vault=${vault.name}`, "eval", "code=app.vault.getName()"]);
	if (!ping.includes("=> ")) {
		console.error(`Cannot talk to Obsidian (${ping.trim()}). Is Obsidian running with the CLI enabled (Settings > General > Advanced)?`);
		process.exit(2);
	}

	const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
	const probePath = PROBE.replace(/\\/g, "/");
	const report = { vault: vault.name, vaultPath: vault.path, obsidian: cli(exe, ["version"]).trim(), notes: [] };
	for (const note of notes) {
		const slug = note.replace(/\.md$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
		const params = { note, outDir, slug, snippet: o.snippet, enableSnippet: o.enableSnippet, trustMermaid: o.trustMermaid, tolerancePx: o.tolerance, settleMs: o.settle };
		// Everything is passed base64-encoded so no quoting or "\n" handling by the CLI can mangle it.
		const code = `(0,eval)(require('fs').readFileSync(Buffer.from('${b64(probePath)}','base64').toString(),'utf8'))(Buffer.from('${b64(JSON.stringify(params))}','base64').toString())`;
		let r;
		try {
			r = evalInApp(exe, vault.name, code, { timeout: o.settle + 120000 });
			if (typeof r !== "object" || r === null) r = { note, fatal: "unexpected probe output: " + String(r).slice(0, 500) };
		} catch (e) {
			r = { note, fatal: e.message };
		}
		r.problems = problemsOf(r, o);
		r.ok = r.problems.length === 0;
		report.notes.push(r);
	}
	report.ok = report.notes.every((n) => n.ok);
	if (outDir) writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));

	if (o.json) console.log(JSON.stringify(report, null, 2));
	else {
		for (const r of report.notes) {
			if (r.fatal) { console.log(`FAIL ${r.note}: ${r.fatal}`); continue; }
			const c = r.centering;
			console.log(`${r.ok ? "PASS" : "FAIL"} ${r.note}`);
			console.log(`  mermaid   ${r.mermaid.rendered}/${r.mermaid.source} rendered, ${r.mermaid.errors} error(s), ${r.mermaid.guarded} guarded`);
			console.log(`  callouts  ${JSON.stringify(r.callouts)}`);
			console.log(`  links     ${r.links.unresolved.length} unresolved, ${r.links.unresolvedEmbeds.length} unresolved embeds, ${r.links.brokenSubpaths.length} broken #subpaths`);
			console.log(`  frontmatter ${r.frontmatter.present ? (r.frontmatter.parsed ? "parsed (" + r.frontmatter.keys.join(", ") + ")" : "NOT parsed") : "none"}; cssclasses applied: ${r.cssclasses.applied.join(", ") || "-"}`);
			console.log(`  math      ${r.math.rendered} rendered (${r.math.display} display), ${r.math.errors} error(s)`);
			console.log(`  centered  mermaid ${c.mermaid.centered}/${c.mermaid.total}, callouts ${c.callouts.centered}/${c.callouts.total}, math ${c.math.centered}/${c.math.total} (±${c.tolerancePx}px); snippet enabled: ${r.snippetEnabled}`);
			for (const p of r.problems) console.log(`  ! ${p}`);
			for (const n of r.notes) console.log(`  i ${n}`);
			for (const s of r.screenshots) console.log(`  > ${s}`);
		}
		console.log(JSON.stringify(summary(report), null, 2));
	}
	process.exit(report.ok ? 0 : 1);
}

function summary(report) {
	return {
		ok: report.ok,
		notes: report.notes.map((r) =>
			r.fatal
				? { note: r.note, fatal: r.fatal }
				: {
						note: r.note,
						ok: r.ok,
						mermaid: { source: r.mermaid.source, rendered: r.mermaid.rendered, errors: r.mermaid.errors, guarded: r.mermaid.guarded },
						callouts: r.callouts,
						unresolvedLinks: r.links.unresolved.map((l) => l.link),
						unresolvedEmbeds: r.links.unresolvedEmbeds.map((l) => l.link),
						brokenSubpaths: r.links.brokenSubpaths.map((l) => l.link),
						frontmatterParsed: r.frontmatter.parsed,
						math: r.math,
						centering: { mermaid: r.centering.mermaid, callouts: r.centering.callouts, math: r.centering.math, offenders: r.centering.offenders.length },
						snippetEnabled: r.snippetEnabled,
						problems: r.problems.length,
					},
		),
	};
}

main();
