// Test-only discovery of the installed pi SDK. Runtime extensions never import this.
// Adapted from pi-scholar's tests/sdk.mjs so tests run against the pi the user actually has.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageName = "@earendil-works/pi-coding-agent";

function isPiPackage(directory) {
	try {
		return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === packageName;
	} catch {
		return false;
	}
}

function findPiPackage() {
	if (process.env.PI_LEARN_PI_PACKAGE) {
		const explicit = resolve(process.env.PI_LEARN_PI_PACKAGE);
		if (!isPiPackage(explicit)) throw new Error(`PI_LEARN_PI_PACKAGE is not the ${packageName} directory: ${explicit}`);
		return explicit;
	}
	const candidates = new Set();
	const home = process.env.USERPROFILE || process.env.HOME || "";
	if (home) candidates.add(join(home, "AppData", "Local", "pi-node", "current", "node_modules", packageName));
	candidates.add(join(dirname(process.execPath), "node_modules", packageName));
	candidates.add(join(dirname(process.execPath), "..", "lib", "node_modules", packageName));
	for (const anchor of [import.meta.url, join(repoRoot, "package.json")]) {
		const requireFrom = createRequire(anchor);
		for (const modules of requireFrom.resolve.paths(packageName) || []) candidates.add(join(modules, packageName));
	}
	for (const candidate of candidates) if (isPiPackage(candidate)) return resolve(candidate);
	try {
		const globalModules = execFileSync(
			process.platform === "win32" ? "cmd.exe" : "npm",
			process.platform === "win32" ? ["/d", "/s", "/c", "npm root --global"] : ["root", "--global"],
			{ encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		const candidate = join(globalModules, packageName);
		if (isPiPackage(candidate)) return resolve(candidate);
	} catch {
		/* explicit configuration works without npm on PATH */
	}
	throw new Error(`Cannot locate ${packageName}. Install pi, or set PI_LEARN_PI_PACKAGE to its package directory.`);
}

export const piPackageRoot = findPiPackage();
export const piVersion = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8")).version;
export const loaderPath = join(piPackageRoot, "dist", "core", "extensions", "loader.js");
export const sdkIndexPath = join(piPackageRoot, "dist", "index.js");

/** `{ loadExtensions, createExtensionRuntime, ... }` from pi's extension loader (uses pi's own jiti + aliases). */
export async function importPiLoader() {
	if (!existsSync(loaderPath)) throw new Error(`pi extension loader missing: ${loaderPath}`);
	return import(pathToFileURL(loaderPath).href);
}

/** The public SDK (`createAgentSession`, `SessionManager`, `DefaultResourceLoader`, ...). */
export async function importPiSdk() {
	return import(pathToFileURL(sdkIndexPath).href);
}

/** Absolute paths of this package's extension entry points, from package.json's pi manifest. */
export function packageExtensionPaths() {
	const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	return (manifest.pi?.extensions ?? []).map((p) => resolve(repoRoot, p));
}

export const skillsDir = join(repoRoot, "skills");
