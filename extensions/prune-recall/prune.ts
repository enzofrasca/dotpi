/**
 * Stub old bulky tool results in the prompt only. JSONL stays intact for recall.
 * Last KEEP_RECENT (3) stay full. Older ones over STUB_OVER (800) become a
 * one-line head 70% + tail 30% stub (STUB_HEAD 400, ERROR_HEAD 800).
 * Non-text/object payloads are measured via JSON so large image/structured
 * blocks are stubbed too. Small results return flat without prefix overhead.
 *
 * Cache-safe: rewriting history busts the provider prompt cache from the first
 * changed message on (Anthropic: whole conversation, since it only reads the
 * previous breakpoint). So stubbing is batched and monotonic: new candidates
 * are stubbed only when they add up to BATCH_CHARS (~20k tokens) or the cache
 * is already cold (last assistant reply older than the cache TTL). Once a
 * result is stubbed it stays stubbed with the same deterministic text, so the
 * prefix is stable between batches. State is in memory, keyed by toolCallId.
 * Kill switches: PI_TOOL_PRUNE=0, PI_DELEGATE=1
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEEP_RECENT = 3;
const STUB_OVER = 800;
const STUB_HEAD = 400;
const ERROR_HEAD = 800;
/** Min chars of new stub candidates before rewriting a warm prefix (~20k tokens). */
const BATCH_CHARS = 80_000;
/** Cache TTL: 5 min default; PI_CACHE_RETENTION=long uses Anthropic's 1 h tier. */
const COLD_MS = (process.env.PI_CACHE_RETENTION === "long" ? 60 : 5) * 60_000;

/** toolCallIds already stubbed. Monotonic: never removed. */
const stubbed = new Set<string>();

type Textish = { type?: string; text?: string };

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		if (content == null) return "";
		if (typeof content === "object") {
			try {
				return JSON.stringify(content) ?? "";
			} catch {
				return String(content);
			}
		}
		return "";
	}
	const texts = content
		.filter((b): b is Textish => !!b && typeof b === "object" && (b as Textish).type === "text")
		.map((b) => (typeof b.text === "string" ? b.text : ""))
		.join("\n");
	if (texts.trim().length > 0) return texts;
	// No text blocks (image/structured) or empty text with large payload:
	// estimate size via JSON so it gets stubbed instead of passing intact.
	// Truncate long string values (e.g. base64 images) in the replacer so we
	// never build a multi-MB output string just to measure it.
	try {
		return (
			JSON.stringify(content, (_k, v) =>
				typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v,
			) ?? ""
		);
	} catch {
		return texts;
	}
}

function stubBody(text: string, head: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= head) return flat;
	const h = Math.ceil(head * 0.7);
	const t = Math.floor(head * 0.3);
	if (t <= 0) return `[tool-prune:${text.length}→${head}] ${flat.slice(0, h)}…`;
	return `[tool-prune:${text.length}→${head}] ${flat.slice(0, h)} … ${flat.slice(-t)}`;
}

type Msg = { role: string; content?: unknown; isError?: boolean; toolCallId?: string; timestamp?: number };

function isCold(messages: Msg[], now: number): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		return typeof m.timestamp === "number" && now - m.timestamp > COLD_MS;
	}
	return false;
}

function pruneToolResults<T extends Msg>(messages: T[], now = Date.now()): T[] {
	const idxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "toolResult" && messages[i].toolCallId) idxs.push(i);
	}
	const texts = new Map<number, string>();
	let fresh = 0;
	const candidates: string[] = [];
	for (const i of idxs.slice(0, Math.max(0, idxs.length - KEEP_RECENT))) {
		const id = messages[i].toolCallId as string;
		if (stubbed.has(id)) continue;
		const text = resultText(messages[i].content);
		if (text.length <= STUB_OVER) continue;
		texts.set(i, text);
		candidates.push(id);
		fresh += text.length;
	}
	if (candidates.length && (fresh >= BATCH_CHARS || isCold(messages, now))) {
		for (const id of candidates) stubbed.add(id);
	}
	if (!stubbed.size) return messages;
	return messages.map((msg, i) => {
		if (msg.role !== "toolResult" || !msg.toolCallId || !stubbed.has(msg.toolCallId)) return msg;
		const text = texts.get(i) ?? resultText(msg.content);
		if (text.length <= STUB_OVER) return msg;
		const stub = stubBody(text, msg.isError ? ERROR_HEAD : STUB_HEAD);
		return { ...msg, content: [{ type: "text" as const, text: stub }] };
	});
}

export function registerToolPrune(pi: ExtensionAPI): void {
	if (process.env.PI_DELEGATE === "1") return;
	if (process.env.PI_TOOL_PRUNE === "0") return;

	pi.on("context", (event) => {
		return { messages: pruneToolResults(event.messages) };
	});
}
