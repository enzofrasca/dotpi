/**
 * Algorithmic /compact — no LLM, no extra tools, no auto-continue.
 *
 * Replaces Pi's summarization call via session_before_compact.
 * Keeps Pi's cut (firstKeptEntryId). Kill switch: PI_LEAN_COMPACT=0.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

const LINE = 120;
const TRANSCRIPT_CHARS = 8_000;
const GOAL_MAX = 6;
const FILE_MAX = 40;
const OUTSTANDING_MAX = 8;
const ARG_MAX = 72;

const TOOL_KEYS = ["path", "command", "query", "pattern", "url", "task", "file", "target"] as const;

export type FileLists = { read: string[]; modified: string[] };

export function compile(opts: {
	messages: unknown[];
	previousSummary?: string;
	fileOps?: { read: Iterable<string>; written: Iterable<string>; edited: Iterable<string> };
	customInstructions?: string;
	cwd?: string;
}): { summary: string; readFiles: string[]; modifiedFiles: string[] } {
	const cwd = opts.cwd;
	const llm = convertToLlm((opts.messages ?? []) as Parameters<typeof convertToLlm>[0]);
	const extracted = extract(llm, cwd);
	const prev = parsePrevious(opts.previousSummary ?? "", cwd);
	const files = mergeFiles(prev.files, listsFromOps(opts.fileOps), extracted.files);

	const goal = unique([...prev.goal, ...extracted.goal])
		.map((g) => clip(flatten(g), LINE - 2))
		.slice(0, GOAL_MAX);
	const outstanding = (extracted.outstanding.length ? extracted.outstanding : prev.outstanding)
		.map((o) => clip(flatten(o), LINE - 2))
		.slice(-OUTSTANDING_MAX);
	const transcript = rollTranscript(prev.transcript, extracted.transcript);

	const parts: string[] = [];
	if (opts.customInstructions?.trim()) {
		parts.push("## Focus", ...wrapLine(flatten(opts.customInstructions), LINE));
	}
	if (goal.length) parts.push("## Goal", ...goal.map((g) => `- ${g}`));
	const fileBlock = formatFiles(files, cwd);
	if (fileBlock) parts.push("## Files", fileBlock);
	if (outstanding.length) parts.push("## Outstanding", ...outstanding.map((o) => `- ${o}`));
	if (transcript) parts.push("## Transcript", transcript);

	let summary = parts.join("\n") || "(empty)";
	summary = wrapSummary(summary);
	return {
		summary,
		readFiles: files.read.slice(0, FILE_MAX),
		modifiedFiles: files.modified.slice(0, FILE_MAX),
	};
}

export function registerLeanCompact(pi: ExtensionAPI): void {
	if (process.env.PI_DELEGATE === "1") return;
	if (process.env.PI_LEAN_COMPACT === "0") return;

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions } = event;
		if (!preparation.firstKeptEntryId) return;

		const { summary, readFiles, modifiedFiles } = compile({
			messages: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
			previousSummary: preparation.previousSummary,
			fileOps: preparation.fileOps,
			customInstructions,
			cwd: ctx.cwd,
		});

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles, modifiedFiles },
			},
		};
	});
}

function extract(messages: Message[], cwd?: string): {
	goal: string[];
	files: FileLists;
	outstanding: string[];
	transcript: string[];
} {
	const goal: string[] = [];
	const files: FileLists = { read: [], modified: [] };
	const outstanding: string[] = [];
	const transcript: string[] = [];
	const read = new Set<string>();
	const written = new Set<string>();
	const edited = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const text = asText(msg.content).trim();
			if (!text || isSummaryWrap(text)) continue;
			const line = flatten(text);
			if (!line) continue;
			if (goal.length === 0) goal.push(clip(line, LINE - 2));
			transcript.push(clip(`[user] ${line}`, LINE));
			continue;
		}
		if (msg.role === "assistant") {
			const texts: string[] = [];
			const tools: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) texts.push(block.text);
				if (block.type !== "toolCall") continue;
				noteFile(block.name, block.arguments, read, written, edited);
				const arg = toolArg(block.arguments, cwd);
				tools.push(arg ? `* ${block.name} ${arg}` : `* ${block.name}`);
			}
			const prose = flatten(texts.join(" "));
			if (prose) transcript.push(clip(`[assistant] ${prose}`, LINE));
			transcript.push(...tools.map((t) => clip(t, LINE)));
			continue;
		}
		if (msg.role === "toolResult") {
			if (!isFail(msg)) continue;
			const body = clip(flatten(asText(msg.content)), 100);
			outstanding.push(clip(`${msg.toolName}: ${body || "error"}`, LINE - 2));
		}
	}

	files.read = [...read].sort();
	files.modified = [...new Set([...written, ...edited])].sort();
	files.read = files.read.filter((f) => !files.modified.includes(f));
	return { goal, files, outstanding, transcript };
}

function noteFile(
	name: string,
	args: Record<string, unknown> | undefined,
	read: Set<string>,
	written: Set<string>,
	edited: Set<string>,
): void {
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (!path) return;
	if (name === "read") read.add(path);
	else if (name === "write") written.add(path);
	else if (name === "edit") edited.add(path);
}

function toolArg(args: Record<string, unknown> | undefined, cwd?: string): string {
	if (!args) return "";
	for (const k of TOOL_KEYS) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) {
			const shown = k === "path" || k === "file" || k === "target" ? shortPath(v, cwd) : v;
			return clip(flatten(shown), ARG_MAX);
		}
	}
	return "";
}

function isFail(msg: { isError: boolean; content: unknown; details?: unknown }): boolean {
	if (msg.isError) return true;
	const details = msg.details;
	if (details && typeof details === "object" && "exitCode" in details) {
		const code = (details as { exitCode?: unknown }).exitCode;
		if (typeof code === "number" && code !== 0) return true;
	}
	return false;
}

function asText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => !!b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

function isSummaryWrap(text: string): boolean {
	return text.startsWith("The conversation history before this point was compacted");
}

function flatten(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function listsFromOps(ops?: { read: Iterable<string>; written: Iterable<string>; edited: Iterable<string> }): FileLists {
	if (!ops) return { read: [], modified: [] };
	const modified = new Set([...ops.edited, ...ops.written]);
	return {
		read: [...ops.read].filter((f) => !modified.has(f)).sort(),
		modified: [...modified].sort(),
	};
}

function mergeFiles(...lists: FileLists[]): FileLists {
	const read = new Set<string>();
	const modified = new Set<string>();
	for (const l of lists) {
		for (const f of l.modified) if (!isOverflow(f)) modified.add(f);
		for (const f of l.read) if (!isOverflow(f)) read.add(f);
	}
	return {
		read: [...read].filter((f) => !modified.has(f)).sort(),
		modified: [...modified].sort(),
	};
}

function isOverflow(p: string): boolean {
	return p.startsWith("…+");
}

function formatFiles(files: FileLists, cwd?: string): string {
	const lines: string[] = [];
	const pushGroup = (label: string, paths: string[]) => {
		if (!paths.length) return;
		const extra = Math.max(0, paths.length - FILE_MAX);
		lines.push(`${label}:`);
		for (const f of paths.slice(0, FILE_MAX)) {
			lines.push(`- ${clipPath(shortPath(f, cwd), LINE - 2)}`);
		}
		if (extra) lines.push(`- …+${extra} more`);
	};
	pushGroup("modified", files.modified);
	pushGroup("read", files.read);
	return lines.join("\n");
}

function shortPath(p: string, cwd?: string): string {
	if (!p || isOverflow(p)) return p;
	const home = os.homedir();
	const full = path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : p;
	if (cwd) {
		const rel = path.relative(cwd, full);
		if (rel === "") return ".";
		if (rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)) return rel;
	}
	if (full === home) return "~";
	if (full.startsWith(`${home}${path.sep}`)) return `~${full.slice(home.length)}`;
	return p;
}

function expandPath(p: string, cwd?: string): string {
	if (!p || isOverflow(p) || p.includes("…")) return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	if (cwd && !path.isAbsolute(p)) return path.resolve(cwd, p);
	return p;
}

function clipPath(p: string, n: number): string {
	if (p.length <= n) return p;
	const prefix = p.startsWith("~/") ? "~/" : "";
	const parts = p.split("/");
	for (let keep = Math.min(3, parts.length); keep >= 1; keep--) {
		const inner = `${prefix}…/${parts.slice(-keep).join("/")}`;
		if (inner.length <= n) return inner;
	}
	return `…${p.slice(-(n - 1))}`;
}

function parsePrevious(
	summary: string,
	cwd?: string,
): { goal: string[]; files: FileLists; outstanding: string[]; transcript: string[] } {
	if (!summary.trim()) {
		return { goal: [], files: { read: [], modified: [] }, outstanding: [], transcript: [] };
	}
	const goal = bullets(section(summary, "Goal")).map((b) => clip(flatten(b), LINE - 2));
	const outstanding = bullets(section(summary, "Outstanding")).map((b) => clip(flatten(b), LINE - 2));
	const files = filesFromPrevious(summary, cwd);
	const transcript = section(summary, "Transcript")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter(Boolean);
	return { goal, files, outstanding, transcript };
}

function filesFromPrevious(summary: string, cwd?: string): FileLists {
	const files: FileLists = { read: xmlList(summary, "read-files"), modified: xmlList(summary, "modified-files") };
	const block = section(summary, "Files");
	let kind: "modified" | "read" | null = null;
	const push = (raw: string) => {
		if (!kind || isOverflow(raw) || raw.includes("…")) return;
		const full = expandPath(raw, cwd);
		if (kind === "modified") files.modified.push(full);
		else files.read.push(full);
	};
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "modified:" || line === "modified") {
			kind = "modified";
			continue;
		}
		if (line === "read:" || line === "read") {
			kind = "read";
			continue;
		}
		const labeled = line.match(/^(modified|read):\s*(.*)$/);
		if (labeled) {
			kind = labeled[1] as "modified" | "read";
			for (const item of labeled[2].split(",").map((s) => s.trim()).filter(Boolean)) push(item);
			continue;
		}
		if (!kind) continue;
		const item = line.startsWith("- ") ? line.slice(2).trim() : line;
		if (item.includes(",") && !item.startsWith("/")) {
			for (const part of item.split(",").map((s) => s.trim()).filter(Boolean)) push(part);
			continue;
		}
		push(item);
	}
	return mergeFiles(files);
}

function xmlList(md: string, tag: string): string[] {
	const m = md.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
	if (!m) return [];
	return m[1]
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

function section(md: string, heading: string): string {
	const re = new RegExp(`(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n<[a-z-]+>|$)`);
	const m = md.match(re);
	return m?.[1]?.trim() ?? "";
}

function bullets(block: string): string[] {
	const out: string[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("- ")) {
			out.push(line.slice(2).trim());
			continue;
		}
		if (out.length) out[out.length - 1] = clip(flatten(`${out[out.length - 1]} ${line}`), LINE - 2);
		else out.push(line);
	}
	return out;
}

function unique(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		const key = item.toLowerCase();
		if (!item || seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function rollTranscript(prev: string[], next: string[]): string {
	const lines = [...prev, ...next];
	let text = lines.join("\n");
	if (text.length <= TRANSCRIPT_CHARS) return text;
	text = text.slice(text.length - TRANSCRIPT_CHARS);
	const nl = text.indexOf("\n");
	return (nl >= 0 ? text.slice(nl + 1) : text).trim();
}

function wrapSummary(summary: string): string {
	return summary
		.split("\n")
		.flatMap((line) => wrapLine(line, LINE))
		.join("\n");
}

function wrapLine(s: string, width: number): string[] {
	if (s.length <= width) return [s];
	const out: string[] = [];
	let rest = s;
	while (rest.length > width) {
		let cut = rest.lastIndexOf(" ", width);
		if (cut < Math.floor(width * 0.55)) cut = width;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) out.push(rest);
	return out.length ? out : [""];
}
