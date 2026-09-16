/**
 * Grep the session JSONL after compact. Native card is not the history.
 * Kill switch: PI_RECALL=0
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { asTextWithToolCalls, clip, flatten, redact } from "./text.ts";

const PAGE_SIZE = 5;
const SEARCH_CHARS = 6_000;
const EXPAND_CHARS = 12_000;
const RESULT_CLIP = 600;
const EXPAND_CLIP = 2_000;
const BROWSE_N = 25;
const HARD_CAP = 20_000;
const TOOLCALL_CLIP = 500;

type Line = {
	index: number;
	id: string;
	role: string;
	/** Original text with \n preserved (used by expand). */
	text: string;
	/** Single-line flattened text (used by search + hits preview). Computed once. */
	flat: string;
	ts: string;
};

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

function queryTerms(query: string): string[] {
	return norm(query)
		.split(/\s+/)
		.filter((t) => t.length >= 2);
}

const Params = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Keywords or a phrase to find in the session log. Omit to browse recent lineage entries.",
		}),
	),
	expand: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Filtered per-scope indices from a prior recall page to expand with more context. Indices are per-scope (active vs all): expand in the same scope used by the search.",
		}),
	),
	page: Type.Optional(Type.Number({ description: "1-based page of search hits. Default 1." })),
	around: Type.Optional(Type.Number({ description: "Extra lineage entries each side of a match. Default 2." })),
	scope: Type.Optional(
		Type.String({
			description: "`active` (default) = current branch lineage, including compacted turns. `all` = whole session file.",
		}),
	),
});

export function registerRecall(pi: ExtensionAPI): void {
	if (process.env.PI_DELEGATE === "1") return;
	if (process.env.PI_RECALL === "0") return;
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: [
			"Search this session's verbatim JSONL after compact. The native compact card is not the full history.",
			"Use for pronouns, prior decisions, paths, errors, or when the card disagrees with the latest user line.",
			"Do not dump the whole session. Prefer a short query, then expand specific indices.",
			"Indices are filtered per-scope (active vs all): expand with the same scope used by the search.",
		].join(" "),
		promptSnippet:
			"After compact, search the session JSONL (query/expand). Use for prior decisions, paths, and pronouns. Do not invent compacted history.",
		promptGuidelines: [
			"If history was compacted, use recall instead of listing the filesystem to reconstruct prior work.",
		],
		executionMode: "parallel" as const,
		parameters: Params,

		async execute(
			_id: string,
			params: {
				query?: string;
				expand?: number[];
				page?: number;
				around?: number;
				scope?: string;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const lines = collectLines(ctx, params.scope === "all" ? "all" : "active");
			if (!lines.length) {
				return {
					content: [{ type: "text" as const, text: "No session log is available to recall." }],
					details: {},
					isError: true,
				};
			}

			if (params.expand?.length) {
				return {
					content: [{ type: "text" as const, text: clipHard(formatExpand(lines, params.expand)) }],
					details: {},
				};
			}

			const query = params.query?.trim() ?? "";
			const around = clampInt(params.around, 0, 6, 2);
			const page = Math.max(1, Math.floor(params.page ?? 1));
			if (query && queryTerms(query).length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Query muito curta: ${JSON.stringify(query)} — use ao menos um termo com 2+ letras (ex "jar" em vez de "a b").`,
						},
					],
					details: {},
				};
			}
			const hits = query ? searchLines(lines, query) : browseLines(lines);
			// Adaptive around: few hits -> show more context (capped at 6).
			const effAround =
				hits.length > 0 && hits.length <= 3 ? Math.min(6, Math.max(around, 4)) : around;
			return {
				content: [{ type: "text" as const, text: clipHard(formatHits(lines, hits, query, page, effAround)) }],
				details: {},
			};
		},

		renderCall(args: { query?: string; expand?: number[] }, theme: Theme) {
			const preview = args.expand?.length
				? `expand ${args.expand.join(",")}`
				: args.query
					? clip(args.query, 70)
					: "browse";
			return new Text(theme.fg("toolTitle", theme.bold("recall ")) + theme.fg("dim", preview));
		},
	});
}

function searchLines(lines: Line[], query: string): number[] {
	const terms = queryTerms(query);
	if (!terms.length) return [];
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const hay = norm(lines[i].flat);
		if (terms.every((t) => hay.includes(t))) hits.push(i);
	}
	return hits;
}

function browseLines(lines: Line[]): number[] {
	const start = Math.max(0, lines.length - BROWSE_N);
	return Array.from({ length: lines.length - start }, (_, i) => start + i);
}

function collectLines(ctx: ExtensionContext, scope: "active" | "all"): Line[] {
	const sm = ctx.sessionManager;
	const entries: SessionEntry[] = scope === "all" ? sm.getEntries() : sm.getBranch();
	const out: Line[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; content?: unknown; toolName?: string };
		const role = msg.role || "message";
		// Keep original newlines for expand; flatten only once into `flat` for search.
		const text = asTextWithToolCalls(msg.content, TOOLCALL_CLIP);
		if (!text.trim()) continue;
		const flat = flatten(text);
		if (!flat) continue;
		const anyEntry = entry as unknown as { timestamp?: unknown; createdAt?: unknown; time?: unknown };
		const rawTs = anyEntry.timestamp ?? anyEntry.createdAt ?? anyEntry.time;
		const ts = typeof rawTs === "string" || typeof rawTs === "number" ? String(rawTs) : "";
		out.push({
			index: out.length,
			id: entry.id,
			role: role === "toolResult" ? `tool_result:${msg.toolName || "tool"}` : role,
			text,
			flat,
			ts,
		});
	}
	return out;
}

function idSuffix(line: Line): string {
	const id = line.id ? ` id=${line.id}` : "";
	const ts = line.ts ? ` ts=${line.ts}` : "";
	return `${id}${ts}`;
}

function formatHits(lines: Line[], hits: number[], query: string, page: number, around: number): string {
	if (!hits.length) {
		if (query && queryTerms(query).length === 0) {
			return `Query muito curta: ${JSON.stringify(query)} — use ao menos um termo com 2+ letras (ex "jar" em vez de "a b").`;
		}
		return query ? `No matches for ${JSON.stringify(query)}.` : "Session lineage is empty.";
	}
	const pages = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
	const p = Math.min(page, pages);
	const slice = hits.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
	const parts = [
		query
			? `${hits.length} match(es) for ${JSON.stringify(query)} · page ${p}/${pages}`
			: `Last ${slice.length} lineage entries`,
		"Use recall expand: [index, ...] for more context (indices are per-scope: same scope active/all).",
		"",
	];
	let used = parts.join("\n").length;
	for (const hi of slice) {
		const from = Math.max(0, hi - around);
		const to = Math.min(lines.length - 1, hi + around);
		const head = lines[hi];
		const block = [
			`--- #${head.index} [${head.role}]${idSuffix(head)} (${from === to ? "" : `${from}-${to} `}match) ---`,
		];
		for (let i = from; i <= to; i++) {
			const mark = i === hi ? "> " : "  ";
			block.push(`${mark}#${lines[i].index} [${lines[i].role}]${idSuffix(lines[i])} ${clip(redact(lines[i].flat), RESULT_CLIP)}`);
		}
		const chunk = block.join("\n") + "\n";
		if (used + chunk.length > SEARCH_CHARS) {
			parts.push("(truncated)");
			break;
		}
		parts.push(chunk.trimEnd());
		used += chunk.length;
	}
	return parts.join("\n");
}

function formatExpand(lines: Line[], indices: number[]): string {
	const parts: string[] = [];
	let used = 0;
	for (const raw of indices.slice(0, 8)) {
		const i = Math.floor(raw);
		if (i < 0 || i >= lines.length) {
			parts.push(`#${i} (out of range for this scope; re-search and expand in the same scope active/all)`);
			continue;
		}
		// Preserve original newlines: no flatten here, clip keeps \n.
		const chunk = `--- #${i} [${lines[i].role}]${idSuffix(lines[i])} ---\n${clip(redact(lines[i].text), EXPAND_CLIP)}\n`;
		if (used + chunk.length > EXPAND_CHARS) {
			parts.push("(truncated)");
			break;
		}
		parts.push(chunk.trimEnd());
		used += chunk.length;
	}
	return parts.join("\n\n") || "Nothing to expand.";
}




function clipHard(s: string): string {
	return s.length <= HARD_CAP ? s : `${s.slice(0, HARD_CAP)}\n(hard cap)`;
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof v !== "number" || Number.isNaN(v)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(v)));
}
