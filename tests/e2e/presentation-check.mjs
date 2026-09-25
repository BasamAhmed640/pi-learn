// Inspect five live lesson notes for reader-facing presentation. This is an evidence
// report, not a substitute for checking factual accuracy and whether an image
// actually depicts the lesson's claimed subject.
//
//   node tests/e2e/presentation-check.mjs tests/e2e/out/<run-id>
//
// Writes report-presentation.json and report-presentation.md. The CLI exits nonzero
// if a run is missing or an objective check fails. Human quality review remains
// explicitly pending until someone reads the five notes and previews any images.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectScenarios } from "./scenarios.mjs";

const presentationScenarios = selectScenarios("presentation");
const wordCount = (text) => (String(text).match(/\b[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*\b/gu) ?? []).length;

/** Keep only rendered teaching prose, including PI callout bodies. */
export function teachingLines(markdown) {
	const withoutYaml = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const lines = [];
	let callout = null;
	let fenced = false;
	for (const original of withoutYaml.split(/\r?\n/)) {
		const header = /^>\s*\[!([\w-]+)\][+-]?\s*(.*)$/.exec(original);
		if (header) {
			callout = header[1].toLowerCase() === "abstract" && /^PI\b/i.test(header[2]) ? "pi" : "other";
			continue;
		}
		if (original.trim() === "") {
			// A note may leave a blank line before the first quoted body line.
			// Preserve the callout until a nonempty, nonquoted line or a new header.
			if (callout !== "other") lines.push("");
			continue;
		}
		if (callout === "other") continue;
		const line = original.replace(/^>\s?/, "");
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced || /^\s*%%.*%%\s*$/.test(line) || /^\s*!\[/.test(line)) continue;
		lines.push(line);
	}
	return lines;
}

export function inspectPresentation(markdown, trace) {
	const lines = teachingLines(markdown);
	const prose = lines.join("\n");
	const headings = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, "").trim());
	const contentHeadings = headings.filter((h) => !/^(?:Session \d|Lesson plan|Plan$|Teaching plan$)/i.test(h));
	const sectionWordCounts = [];
	let section = null;
	for (const line of lines) {
		if (/^#{1,6}\s+\S/.test(line)) {
			if (section) sectionWordCounts.push(section);
			section = { heading: line.replace(/^#{1,6}\s+/, "").trim(), words: 0 };
		} else if (section) section.words += wordCount(line);
	}
	if (section) sectionWordCounts.push(section);
	const substantialSections = sectionWordCounts.filter((s) => s.words >= 100 && !/^(?:Session \d|Lesson plan|Plan$|Teaching plan$|Phase\s+[12])/i.test(s.heading));
	const workflowHeadings = headings.filter((h) => /^(?:Phase\s+\d|Node\s+\d|Internal|Reasoning|Analysis|Scratchpad)\b/i.test(h));
	const leakPatterns = [
		/\b(?:system prompt|developer instruction|chain[ -]of[ -]thought|tool_call|function call|token budget)\b/i,
		/^\s*(?:let me think|i need to decide|we need to decide|i should now|my reasoning\s*:|analysis\s*:|thinking\s*:)/i,
		/<\/?(?:analysis|thinking)>/i,
	];
	const reasoningLeaks = [];
	for (const [index, line] of lines.entries()) {
		if (leakPatterns.some((p) => p.test(line))) reasoningLeaks.push({ line: index + 1, text: line.trim().slice(0, 160) });
	}
	const longParagraphs = prose.split(/\n\s*\n/).filter((p) => {
		const first = p.trimStart();
		return first && !/^(?:#|[-*+]\s|\d+[.)]\s|\|)/.test(first);
	}).map((p) => ({ words: wordCount(p), excerpt: p.replace(/\s+/g, " ").slice(0, 140) })).filter((p) => p.words > 160);

	const phases = trace.phases?.length ? trace.phases : [trace];
	const calls = phases.flatMap((p) => p.toolCalls ?? []);
	const postPlanText = phases.flatMap((p) => {
		const approvedAtTurn = p.driver?.approvedAtTurn;
		if (!approvedAtTurn) return [];
		const planMessages = new Set(p.driver?.planMessageIds ?? []);
		return (p.assistantMessages ?? []).filter((m) => m.turn >= approvedAtTurn && !planMessages.has(m.index)).map((m) => m.text ?? "");
	}).join("\n\n");
	const postPlanSections = [];
	let postSection = null;
	for (const line of postPlanText.split(/\r?\n/)) {
		if (/^#{2,4}\s+\S/.test(line)) {
			if (postSection) postPlanSections.push(postSection);
			postSection = { heading: line.replace(/^#{2,4}\s+/, "").trim(), words: 0 };
		} else if (postSection && !/^\s*(```|%%)/.test(line)) postSection.words += wordCount(line);
	}
	if (postSection) postPlanSections.push(postSection);
	const substantialPostPlanSections = postPlanSections.filter((s) => s.words >= 100 && !/^(?:Phase\s+[12]|Learning path|Lesson plan|Plan$|Teaching plan$)/i.test(s.heading));
	const quizzes = calls.filter((c) => c.name === "quiz" && c.executed);
	const postPlanQuizzes = quizzes.filter((c) => c.afterApproval);
	const weakQuestions = quizzes.map((q) => {
		const issues = [];
		const options = q.args?.options ?? [];
		const labels = options.map((o) => String(o.label ?? "").trim().toLowerCase());
		if (wordCount(q.args?.question ?? "") < 5) issues.push("question under five words");
		if (options.length < 2) issues.push("fewer than two choices");
		if (new Set(labels).size !== labels.length) issues.push("duplicate choices");
		if (wordCount(q.args?.explanation ?? "") < 20) issues.push("feedback under 20 words");
		return { question: String(q.args?.question ?? ""), afterApproval: !!q.afterApproval, issues };
	}).filter((q) => q.issues.length);
	const questionCallouts = (markdown.match(/^>\s*\[!question\]\s*(?:Quiz|Question)\s*$/gm) ?? []).length;
	const answerCallouts = (markdown.match(/^>\s*\[!(?:success|failure|example|warning|question)\]\s*(?:Quiz\s+[—-]|Answer\b|Question\s+[—-])/gm) ?? []).length;
	const feedbacks = [];
	const mdLines = markdown.split(/\r?\n/);
	for (let i = 0; i < mdLines.length; i++) {
		if (!/^>\s*\[!(?:success|failure|warning|question)\]\s*Quiz\s+[—-]/.test(mdLines[i])) continue;
		const body = [];
		for (let j = i + 1; j < mdLines.length && /^>/.test(mdLines[j]); j++) body.push(mdLines[j].replace(/^>\s?/, ""));
		feedbacks.push({ hasAnswer: /Correct answer\s*:/i.test(body.join("\n")), words: wordCount(body.join(" ")) });
	}
	const weakFeedbacks = feedbacks.filter((f) => !f.hasAnswer || f.words < 25);

	const images = [];
	const imagePattern = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g;
	for (const match of markdown.matchAll(imagePattern)) {
		const next = markdown.slice(match.index + match[0].length, match.index + match[0].length + 900);
		images.push({
			alt: match[1],
			path: match[2] ?? match[3],
			hasObservation: /\b(?:Notice|Look for|Observe|What to notice)\s*:/i.test(next),
			hasAttribution: /\b(?:Wikimedia Commons|Source on Wikimedia Commons)\b/i.test(next) && /\b(?:CC|Creative Commons|public domain)\b/i.test(next),
		});
	}
	const imageSearches = calls.filter((c) => c.name === "search_commons_images").length;
	const imports = calls.filter((c) => c.name === "import_commons_image" && c.executed).length;
	const conceptDiagramCount = (markdown.match(/^%%\s*system\s*:/gm) ?? []).length;
	const incomplete = phases.flatMap((p) => [
		...(["timeout", "error"].includes(p.driver?.stopReason) ? [`stopped ${p.driver.stopReason}`] : []),
		...(p.resources?.extensionLoadErrors ?? []).map(() => "extension load error"),
		...(p.extensionErrors ?? []).map(() => "extension runtime error"),
	]);
	if (trace.fatal) incomplete.push(`fatal: ${String(trace.fatal).split("\n")[0]}`);
	const checks = [
		{ id: "run-complete", pass: incomplete.length === 0, detail: incomplete.join("; ") || "no timeout, fatal or extension error" },
		{ id: "book-section", pass: contentHeadings.length >= 1 && substantialSections.length >= 1 && substantialPostPlanSections.length >= 1 && wordCount(prose) >= 140, detail: `${contentHeadings.length} reader-facing heading(s), ${substantialSections.length} substantial note section(s), ${substantialPostPlanSections.length} substantial section(s) after plan approval, ${wordCount(prose)} teaching words` },
		{ id: "no-visible-process", pass: workflowHeadings.length === 0 && reasoningLeaks.length === 0, detail: `${workflowHeadings.length} workflow heading(s), ${reasoningLeaks.length} reasoning marker(s)` },
		{ id: "scannable-prose", pass: longParagraphs.length === 0, detail: `${longParagraphs.length} paragraph(s) over 160 words` },
		{ id: "question-record", pass: quizzes.length > 0 && questionCallouts >= quizzes.length && answerCallouts >= quizzes.length, detail: `${quizzes.length} executed quiz(es), ${questionCallouts} question and ${answerCallouts} answer callout(s)` },
		{ id: "post-plan-check", pass: postPlanQuizzes.length >= 1, detail: `${postPlanQuizzes.length} executed quiz(es) after plan approval` },
		{ id: "question-shape", pass: weakQuestions.length === 0, detail: `${weakQuestions.length} question(s) with short/duplicate choices or short feedback` },
		{ id: "feedback-content", pass: feedbacks.length >= quizzes.length && weakFeedbacks.length === 0, detail: `${feedbacks.length} rendered quiz feedback block(s), ${weakFeedbacks.length} missing answer text or under 25 words` },
		{ id: "image-captions", pass: images.every((i) => wordCount(i.alt) >= 6 && i.hasObservation && i.hasAttribution), detail: `${images.length} image(s), ${imports} successful import(s), ${imageSearches} search(es); each image needs descriptive alt text, observation and attribution` },
	];
	return { headings, contentHeadings, substantialSections, substantialPostPlanSections, workflowHeadings, teachingWords: wordCount(prose), reasoningLeaks, longParagraphs, quizzes: quizzes.map((q) => ({ question: q.args?.question, explanation: q.args?.explanation, afterApproval: !!q.afterApproval })), weakQuestions, questionCallouts, answerCallouts, feedbacks, weakFeedbacks, conceptDiagramCount, imageSearches, imports, images, checks };
}

function markdownReport(report) {
	const out = [
		`# Presentation check — ${report.runId}`,
		"",
		`Automated note checks: **${report.summary.passed}/${report.summary.total} topics pass**. These checks flag likely leaks and layout problems; they do not prove factual accuracy, question diagnostic value or image fit.`,
		"",
		"| Topic | Layout | Process hidden | Questions | Images | Automated |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const s of report.topics) {
		const mark = (id) => s.checks.find((c) => c.id === id)?.pass ? "✓" : "✗";
		out.push(`| ${s.topic.replace(/\|/g, "\\|")} | ${mark("book-section")}/${mark("scannable-prose")} | ${mark("no-visible-process")} | ${mark("question-record")}/${mark("post-plan-check")}/${mark("question-shape")} | ${s.images.length} imported, ${s.imageSearches} searches | ${s.automatedPass ? "✓" : "✗"} |`);
	}
	out.push("", "## Review each note", "", "For each topic, read the linked Markdown note as an Obsidian reader would. Score **clarity**, **visual layout**, **factual accuracy**, **question diagnostic value and feedback**, and **image fit** from 1–5. An image is optional if no candidate clearly answers the visual need; a decorative or mismatched image is a failure. Record the reason for any score below 4. Do not call the release fully accepted on automated checks alone.", "");
	for (const s of report.topics) {
		out.push(`### ${s.topic}`, "", `Note: [${s.id}.md](./${s.id}.md)`, "");
		for (const c of s.checks) out.push(`- ${c.pass ? "✓" : "✗"} ${c.id}: ${c.detail}`);
		if (s.workflowHeadings.length) out.push(`- Workflow headings: ${s.workflowHeadings.join("; ")}`);
		for (const leak of s.reasoningLeaks) out.push(`- Possible reasoning leak: ${leak.text}`);
		for (const p of s.longParagraphs) out.push(`- Long paragraph (${p.words} words): ${p.excerpt}…`);
		for (const q of s.weakQuestions) out.push(`- Question shape: ${q.question} — ${q.issues.join(", ")}`);
		for (const img of s.images) out.push(`- Image: ${img.alt} — notice=${img.hasObservation}, attribution=${img.hasAttribution}; inspect preview for subject accuracy.`);
		if (s.images.length === 0 && s.visualSubject) out.push("- No image imported. Review search previews to confirm that skipping the image was appropriate.");
		out.push("", "Manual scores: clarity __/5; layout __/5; factual accuracy __/5; questions __/5; image fit __/5 (or N/A).", "");
	}
	return out.join("\n");
}

export function checkPresentationRun(outDir) {
	outDir = resolve(outDir);
	const topics = presentationScenarios.map((scenario) => {
		const notePath = join(outDir, `${scenario.id}.md`);
		const tracePath = join(outDir, `${scenario.id}.json`);
		if (!existsSync(notePath) || !existsSync(tracePath)) {
			return { id: scenario.id, topic: scenario.topic, visualSubject: scenario.visualSubject, images: [], imageSearches: 0, workflowHeadings: [], reasoningLeaks: [], longParagraphs: [], weakQuestions: [], checks: [{ id: "run-complete", pass: false, detail: `missing ${!existsSync(notePath) ? "note" : "trace"}` }], automatedPass: false };
		}
		const result = inspectPresentation(readFileSync(notePath, "utf8"), JSON.parse(readFileSync(tracePath, "utf8")));
		result.checks.push({ id: "concept-diagram", pass: scenario.kind === "non-system" ? result.conceptDiagramCount === 0 : result.conceptDiagramCount >= 1, detail: `${result.conceptDiagramCount} concept diagram(s) for ${scenario.kind}` });
		if (scenario.visualSubject) result.checks.push({ id: "visual-search", pass: result.imageSearches > 0, detail: `${result.imageSearches} Commons search(es) for a visually grounded topic` });
		return { id: scenario.id, topic: scenario.topic, visualSubject: scenario.visualSubject, ...result, automatedPass: result.checks.every((c) => c.pass) };
	});
	const report = { runId: basename(outDir), generatedAt: new Date().toISOString(), summary: { total: topics.length, passed: topics.filter((s) => s.automatedPass).length }, topics, manualReview: "required" };
	writeFileSync(join(outDir, "report-presentation.json"), JSON.stringify(report, null, 2));
	writeFileSync(join(outDir, "report-presentation.md"), markdownReport(report));
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = process.argv[2];
	if (!outDir || !existsSync(outDir)) {
		console.error("usage: node tests/e2e/presentation-check.mjs tests/e2e/out/<run-id>");
		process.exit(2);
	}
	const report = checkPresentationRun(outDir);
	console.log(`presentation: ${report.summary.passed}/${report.summary.total} automated checks pass -> ${join(resolve(outDir), "report-presentation.md")}`);
	process.exit(report.summary.passed === report.summary.total ? 0 : 1);
}
