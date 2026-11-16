import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { clampPercent, formatDurationLeft } from "./format";
import { C, EFFORT, gradient, k, level, paint, renderBar, type Seg, usageColor } from "./bar";
import {
	cursorUsage,
	cursorUsageFresh,
	ensureCursorUsage,
	formatCursorUsage,
	isCursorModel,
	markCursorUsageStale,
} from "./cursor-usage";
import {
	codexUsage,
	codexUsageFresh,
	ensureCodexUsage,
	formatCodexUsage,
	isCodexModel,
	markCodexUsageStale,
} from "./codex-usage";
import {
	ensureExperientialUsage,
	experientialUsage,
	experientialUsageFresh,
	formatExperientialUsage,
	isExperientialModel,
	markExperientialUsageStale,
} from "./experiential-usage";

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenModelName(name: string): string {
	if (!name) return "?";
	const parts = name.split("/");
	return parts[parts.length - 1]!;
}

function isXaiGrokModel(model: { provider?: string; id?: string } | undefined | null): boolean {
	if (!model?.provider || !model.id) return false;
	const provider = model.provider.toLowerCase();
	// Built-in xAI provider, custom proxy extension, or any *xai* provider id
	const isXai =
		provider === "xai" ||
		provider === "grok-proxy" ||
		provider.includes("xai");
	if (!isXai) return false;
	const id = model.id.toLowerCase();
	// Weekly subscription meter applies to Grok models (4.5, 4.3, build, aliases)
	return id === "grok-4.5" || id.startsWith("grok-4.5") || id.startsWith("grok-");
}

// ── Grok weekly usage (subscription OAuth) ───────────────────────────────────

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const GROK_AUTH_PATH = join(homedir(), ".grok", "auth.json");
const GROK_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_ERROR_TTL_MS = 60_000;

// Same OAuth client / issuer as grok-proxy (Grok Build CLI). Only used to find
// the CLI token in ~/.grok/auth.json: the footer never refreshes or writes tokens.
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60_000;
const XAI_GROK_CLI_AUTH_SCOPE_KEY = `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
const XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";
const TOKEN_SOFT_GRACE_MS = 60_000;

type GrokUsage = {
	/** Percent of weekly pool already used (0–100+). */
	weeklyUsedPercent: number;
	/** ISO reset time for the weekly window, if known. */
	weeklyResetIso?: string;
	/** Optional monthly used/limit from cli-chat-proxy billing. */
	monthlyUsed?: number;
	monthlyLimit?: number;
	monthlyResetIso?: string;
	fetchedAt: number;
	error?: string;
};

type XaiTokenCreds = {
	access: string;
	refresh?: string;
	expires?: number;
	tokenEndpoint?: string;
	source: "grok-cli" | "grok-proxy" | "xai";
};

let cachedUsage: GrokUsage | null = null;
let inflight: Promise<void> | null = null;

function parseExpiry(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isAccessUsable(creds: XaiTokenCreds, now = Date.now()): boolean {
	if (!creds.access) return false;
	if (typeof creds.expires !== "number") return true;
	// Allow a short grace window — JWT may still work past stored expires
	return creds.expires + TOKEN_SOFT_GRACE_MS > now;
}

function readGrokCliCredentials(): XaiTokenCreds | undefined {
	if (!existsSync(GROK_AUTH_PATH)) return undefined;
	try {
		const data = JSON.parse(readFileSync(GROK_AUTH_PATH, "utf8")) as Record<string, unknown>;

		const oidc = data[XAI_GROK_CLI_AUTH_SCOPE_KEY];
		if (oidc && typeof oidc === "object") {
			const entry = oidc as Record<string, unknown>;
			const access = String(entry.key || entry.access_token || entry.token || "");
			if (access) {
				const expiresAt = parseExpiry(entry.expires_at);
				return {
					access,
					refresh: String(entry.refresh_token || entry.refresh || "") || undefined,
					expires: expiresAt !== undefined ? expiresAt - XAI_OAUTH_REFRESH_SKEW_MS : undefined,
					tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
					source: "grok-cli",
				};
			}
		}

		// Older Grok builds stored a bearer at the sign-in URL scope.
		const legacy = data[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
		if (legacy && typeof legacy === "object") {
			const entry = legacy as Record<string, unknown>;
			const access = String(entry.key || entry.access_token || entry.token || "");
			if (access) {
				return {
					access,
					source: "grok-cli",
					expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
				};
			}
		}

		const topLevelAccess = data.access_token || data.token;
		if (topLevelAccess) {
			return {
				access: String(topLevelAccess),
				refresh: String(data.refresh_token || data.refresh || "") || undefined,
				expires: parseExpiry(data.expires_at || data.expires),
				tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
				source: "grok-cli",
			};
		}
	} catch {
		// ignore corrupt grok auth
	}
	return undefined;
}

function readPiAuthCredentials(provider: "grok-proxy" | "xai"): XaiTokenCreds | undefined {
	try {
		const raw = readFileSync(AUTH_PATH, "utf8");
		const auth = JSON.parse(raw) as Record<
			string,
			{
				type?: string;
				access?: string;
				refresh?: string;
				expires?: number;
				tokenEndpoint?: string;
			}
		>;
		const entry = auth[provider];
		if (!entry?.access) return undefined;
		return {
			access: entry.access,
			refresh: entry.refresh,
			expires: typeof entry.expires === "number" ? entry.expires : undefined,
			tokenEndpoint: entry.tokenEndpoint || `${XAI_OAUTH_ISSUER}/oauth2/token`,
			source: provider,
		};
	} catch {
		return undefined;
	}
}

/**
 * Pick an xAI/Grok access token, read-only, in the order chat uses:
 * 1) ~/.grok/auth.json (what grok-proxy keeps fresh)
 * 2) ~/.pi/agent/auth.json grok-proxy
 * 3) ~/.pi/agent/auth.json xai
 *
 * Never refreshes: a refresh here rotated the refresh token without saving it
 * (grok-proxy/xai) or raced the Grok CLI on its file. When every token is
 * expired the footer shows "login" until pi or the CLI refreshes it.
 */
function resolveXaiAccessToken(): string | undefined {
	const candidates = [readGrokCliCredentials(), readPiAuthCredentials("grok-proxy"), readPiAuthCredentials("xai")];
	for (const creds of candidates) {
		if (creds && isAccessUsable(creds)) return creds.access;
	}
	return undefined;
}

// Minimal protobuf helpers for GetGrokCreditsConfigResponse
function readVarint(data: Uint8Array, pos: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (pos < data.length) {
		const b = data[pos++]!;
		value |= (b & 0x7f) << shift;
		if ((b & 0x80) === 0) return [value, pos];
		shift += 7;
		if (shift > 70) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function* iterFields(data: Uint8Array): Generator<[number, number, number | Uint8Array]> {
	let pos = 0;
	while (pos < data.length) {
		const [key, next] = readVarint(data, pos);
		pos = next;
		const number = key >>> 3;
		const wire = key & 0x07;
		if (wire === 0) {
			const [v, p] = readVarint(data, pos);
			pos = p;
			yield [number, wire, v];
		} else if (wire === 1) {
			yield [number, wire, data.subarray(pos, pos + 8)];
			pos += 8;
		} else if (wire === 2) {
			const [len, p] = readVarint(data, pos);
			pos = p;
			yield [number, wire, data.subarray(pos, pos + len)];
			pos += len;
		} else if (wire === 5) {
			yield [number, wire, data.subarray(pos, pos + 4)];
			pos += 4;
		} else {
			throw new Error(`unsupported wire type ${wire}`);
		}
	}
}

function firstMessage(data: Uint8Array, fieldNo: number): Uint8Array | undefined {
	for (const [n, w, v] of iterFields(data)) {
		if (n === fieldNo && w === 2 && v instanceof Uint8Array) return v;
	}
	return undefined;
}

function parseFloat32LE(bytes: Uint8Array): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

function parseTimestampIso(message: Uint8Array | undefined): string | undefined {
	if (!message) return undefined;
	let seconds = 0;
	let nanos = 0;
	for (const [n, w, v] of iterFields(message)) {
		if (n === 1 && w === 0 && typeof v === "number") seconds = v;
		if (n === 2 && w === 0 && typeof v === "number") nanos = v;
	}
	if (!seconds) return undefined;
	return new Date(seconds * 1000 + nanos / 1e6).toISOString();
}

function decodeGrpcWebMessage(body: Uint8Array): Uint8Array {
	const messages: Uint8Array[] = [];
	let i = 0;
	while (i + 5 <= body.length) {
		const flags = body[i]!;
		const length = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0, false);
		i += 5;
		const payload = body.subarray(i, i + length);
		if (payload.length !== length) throw new Error("truncated grpc frame");
		i += length;
		if ((flags & 0x80) === 0) messages.push(payload);
	}
	if (!messages.length) throw new Error("empty grpc message");
	if (messages.length === 1) return messages[0]!;
	const out = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
	let o = 0;
	for (const m of messages) {
		out.set(m, o);
		o += m.length;
	}
	return out;
}

function parseWeeklyFromCredits(payload: Uint8Array): { usedPercent: number; resetIso?: string } {
	const msg = decodeGrpcWebMessage(payload);
	const config = firstMessage(msg, 1);
	if (!config) throw new Error("missing credits config");

	let usedPercent = 0;
	let resetIso: string | undefined;
	for (const [n, w, v] of iterFields(config)) {
		if (n === 1 && w === 5 && v instanceof Uint8Array && v.length >= 4) {
			usedPercent = parseFloat32LE(v);
		} else if (n === 5 && w === 2 && v instanceof Uint8Array) {
			resetIso = parseTimestampIso(v);
		}
	}
	return { usedPercent, resetIso };
}

function moneyishVal(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
		return (v as { val: number }).val;
	}
	return undefined;
}

async function fetchGrokUsage(token: string, signal?: AbortSignal): Promise<GrokUsage> {
	const fetchedAt = Date.now();
	let weeklyUsedPercent = 0;
	let weeklyResetIso: string | undefined;
	let monthlyUsed: number | undefined;
	let monthlyLimit: number | undefined;
	let monthlyResetIso: string | undefined;
	let weeklyOk = false;

	// Weekly pool (Settings → Usage style meter)
	try {
		const res = await fetch(GROK_CREDITS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/grpc-web+proto",
				Accept: "application/grpc-web+proto",
				"X-Grpc-Web": "1",
				Origin: "https://grok.com",
				Referer: "https://grok.com/",
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			},
			// google.protobuf.Empty in a grpc-web data frame
			body: new Uint8Array([0, 0, 0, 0, 0]),
			signal,
		});
		if (!res.ok) throw new Error(`credits HTTP ${res.status}`);
		const buf = new Uint8Array(await res.arrayBuffer());
		const weekly = parseWeeklyFromCredits(buf);
		weeklyUsedPercent = weekly.usedPercent;
		weeklyResetIso = weekly.resetIso;
		weeklyOk = true;
	} catch {
		// fall through — try monthly only
	}

	// cli-chat-proxy billing: only a fallback for the weekly meter. Its monthly
	// numbers are not displayed, so skip the request when weekly already worked.
	if (!weeklyOk) try {
		const res = await fetch(GROK_BILLING_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"x-xai-token-auth": "xai-grok-cli",
				"x-grok-client-version": "0.2.101",
				"x-grok-client-mode": "interactive",
			},
			signal,
		});
		if (res.ok) {
			const payload = (await res.json()) as { config?: Record<string, unknown> };
			const c = payload.config ?? {};
			monthlyLimit = moneyishVal(c.monthlyLimit);
			monthlyUsed = moneyishVal(c.used);
			if (typeof c.billingPeriodEnd === "string") monthlyResetIso = c.billingPeriodEnd;

			// Some accounts expose weekly on this payload too
			const currentPeriod = c.currentPeriod as { type?: string; end?: string } | undefined;
			if (
				!weeklyOk &&
				typeof c.creditUsagePercent === "number" &&
				currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
			) {
				weeklyUsedPercent = c.creditUsagePercent;
				weeklyResetIso = typeof currentPeriod.end === "string" ? currentPeriod.end : monthlyResetIso;
				weeklyOk = true;
			}
		}
	} catch {
		// ignore
	}

	if (!weeklyOk && monthlyUsed == null) {
		return { weeklyUsedPercent: 0, fetchedAt, error: "unavailable" };
	}

	return {
		weeklyUsedPercent,
		weeklyResetIso,
		monthlyUsed,
		monthlyLimit,
		monthlyResetIso,
		fetchedAt,
	};
}

function usageStillFresh(usage: GrokUsage | null): boolean {
	if (!usage) return false;
	const ttl = usage.error ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS;
	return Date.now() - usage.fetchedAt < ttl;
}

function ensureGrokUsage(onUpdate: () => void, signal?: AbortSignal): void {
	if (usageStillFresh(cachedUsage)) return;
	if (inflight) return;

	inflight = (async () => {
		const token = resolveXaiAccessToken();
		if (signal?.aborted) return;
		if (!token) {
			cachedUsage = { weeklyUsedPercent: 0, fetchedAt: Date.now(), error: "no-auth" };
			onUpdate();
			return;
		}

		try {
			const u = await fetchGrokUsage(token, signal);
			if (signal?.aborted) return;
			cachedUsage = u;
			onUpdate();
		} catch (err) {
			if (signal?.aborted) return;
			cachedUsage = {
				weeklyUsedPercent: 0,
				fetchedAt: Date.now(),
				error: err instanceof Error ? err.message : "error",
			};
			onUpdate();
		}
	})()
		// A throw outside the inner try would otherwise be an unhandled rejection.
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
}

function formatGrokUsagePart(usage: GrokUsage | null, loading: boolean): string {
	if (loading && !usage) return "…";
	if (!usage) return "…";
	if (usage.error === "no-auth") return "login";
	if (usage.error && usage.monthlyUsed == null) return "n/a";

	const left = clampPercent(100 - usage.weeklyUsedPercent);
	const reset = usage.weeklyResetIso ? formatDurationLeft(usage.weeklyResetIso) : undefined;
	// e.g. "90% · 6d" (percent of weekly pool remaining)
	return reset ? `${left}% · ${reset}` : `${left}%`;
}

// ── Git dirty state + session cost ───────────────────────────────────────────

// pi's footer data knows the branch but not whether the tree is dirty; one
// async `git status` per cwd, refreshed at most every 10s, never per frame.
const GIT_TTL_MS = 10_000;
const gitState = new Map<string, { dirty: boolean; at: number; running: boolean }>();

function gitDirty(cwd: string, onChange: () => void): boolean {
	const state = gitState.get(cwd) ?? { dirty: false, at: 0, running: false };
	gitState.set(cwd, state);
	if (!state.running && Date.now() - state.at > GIT_TTL_MS) {
		state.running = true;
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain"],
			{ cwd, timeout: 2000 },
			(err, stdout) => {
				const next = !err && stdout.trim().length > 0;
				state.running = false;
				state.at = Date.now();
				if (next !== state.dirty) {
					state.dirty = next;
					onChange();
				}
			},
		);
	}
	return state.dirty;
}

function markGitStale(): void {
	for (const state of gitState.values()) state.at = 0;
}

/** Cost of one entry's usage, if it carries any. */
function entryCost(entry: any): number {
	const usage =
		entry?.type === "usage"
			? entry.usage
			: entry?.type === "message"
				? entry.message?.usage
				: (entry?.type === "branch_summary" || entry?.type === "compaction")
					? entry.usage
					: undefined;
	const c = usage?.cost;
	const n = typeof c === "number" ? c : c?.total;
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Cumulative cost of the session, from every assistant message's usage.
 * `getEntries()` returns a fresh array per call, so the cache is keyed on the
 * entry count + last entry id; entries are append-only, so a grown session
 * only sums the new tail. Runs every frame, so it must stay O(new entries).
 */
let costCache: { count: number; lastId: unknown; total: number } | null = null;

function sessionCost(ctx: ExtensionContext): number {
	try {
		const entries: any[] = (ctx as any).sessionManager?.getEntries?.() ?? [];
		const lastId = entries[entries.length - 1]?.id;
		if (costCache && costCache.count === entries.length && costCache.lastId === lastId) {
			return costCache.total;
		}
		let start = 0;
		let total = 0;
		// Same session, grown since last time: continue from the cached prefix.
		if (
			costCache &&
			costCache.count > 0 &&
			costCache.count < entries.length &&
			entries[costCache.count - 1]?.id === costCache.lastId
		) {
			start = costCache.count;
			total = costCache.total;
		}
		for (let i = start; i < entries.length; i++) total += entryCost(entries[i]);
		costCache = { count: entries.length, lastId, total };
		return total;
	} catch {
		return 0; // cost is decoration
	}
}

// getContextUsage() builds a session projection + token estimate; render runs
// on every keystroke and stream delta, so reuse it for a short while.
const CONTEXT_USAGE_TTL_MS = 500;

// ── Extension Entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tuiRef: { requestRender(): void } | null = null;
	let abort: AbortController | null = null;

	const bump = () => tuiRef?.requestRender();
	let contextUsageMemo: { at: number; value: any } | null = null;
	const contextUsage = (ctx: ExtensionContext) => {
		const now = Date.now();
		if (contextUsageMemo && now - contextUsageMemo.at < CONTEXT_USAGE_TTL_MS) return contextUsageMemo.value;
		const value = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		contextUsageMemo = { at: now, value };
		return value;
	};
	const forgetContextUsage = () => {
		contextUsageMemo = null;
	};
	// turn_end fires on every tool-loop step; force a fresh usage pull at most
	// this often there. agent_settled always forces one at the end of a run.
	const FORCE_REFRESH_MIN_MS = 30_000;
	let lastForcedRefresh = 0;

	const maybeRefreshUsage = (ctx: ExtensionContext) => {
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model)) ensureGrokUsage(bump, abort?.signal);
		if (isCursorModel(model)) ensureCursorUsage(bump, abort?.signal);
		if (isCodexModel(model)) ensureCodexUsage(bump, abort?.signal);
		if (isExperientialModel(model)) ensureExperientialUsage(bump, abort?.signal);
	};

	pi.on("session_start", async (_event, ctx) => {
		forgetContextUsage();
		abort?.abort();
		abort = new AbortController();
		maybeRefreshUsage(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsub();
					tuiRef = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model as { provider?: string; id?: string; name?: string } | undefined;
					const modelId = model?.id || "";

					// Model + thinking level: "Grok 4.7 xhigh" (no level when off)
					const thinkingLevel =
						typeof (pi as any).getThinkingLevel === "function"
							? String((pi as any).getThinkingLevel())
							: "off";
					const modelName = model?.name || shortenModelName(modelId);
					const modelItem: Seg[] | null = modelId
						? [
								...gradient(modelName, C.modelFrom, C.modelTo),
								...(thinkingLevel && thinkingLevel !== "off"
									? [[EFFORT[thinkingLevel] ?? C.dim, ` ${thinkingLevel}`] as Seg]
									: []),
							]
						: null;

					const parts: Seg[][] = [];
					if (modelItem) parts.push(modelItem);

					// Folder + branch + dirty: "agent main*"
					const home = homedir();
					const folderName: Seg[] = [
						[C.folder, ctx.cwd === home ? "~" : ctx.cwd.split(/[/\\]/).filter(Boolean).pop() || ctx.cwd],
					];
					const branch = footerData.getGitBranch();
					const dirty = gitDirty(ctx.cwd, bump);
					const folderItem: Seg[] = [
						...folderName,
						...(branch ? [[C.branch, ` ${branch}`] as Seg] : []),
						...(branch && dirty ? [[C.warning, "*"] as Seg] : []),
					];
					parts.push(folderItem);

					// Context: "3% / 1M" — percent used, and the window's size
					const usageCtx = contextUsage(ctx);
					if (usageCtx?.contextWindow) {
						const known = typeof usageCtx.percent === "number";
						const pct = known ? Math.max(0, Math.min(100, Math.round(usageCtx.percent!))) : 0;
						parts.push([
							[known ? level(pct, C.context) : C.dim, known ? `${pct}%` : "?%"],
							[C.sep, " / "],
							[C.window, k(usageCtx.contextWindow)],
						]);
					}

					// Plan limits of the active provider: "62% · 2h12m · 12% · 3d3h"
					let limitSegs: { text: string; color: string }[] = [];
					if (isXaiGrokModel(model)) {
						if (!usageStillFresh(cachedUsage)) ensureGrokUsage(bump, abort?.signal);
						const left = cachedUsage ? clampPercent(100 - cachedUsage.weeklyUsedPercent) : 100;
						const color = cachedUsage?.error ? "dim" : left <= 10 ? "error" : left <= 25 ? "warning" : "ok";
						limitSegs = formatGrokUsagePart(cachedUsage, !!inflight && !cachedUsage)
							.split(" · ")
							.map((text, i) => ({ text, color: i === 0 ? color : "dim" }));
					} else if (isCursorModel(model)) {
						if (!cursorUsageFresh()) ensureCursorUsage(bump, abort?.signal);
						limitSegs = formatCursorUsage(cursorUsage(), modelId);
					} else if (isCodexModel(model)) {
						if (!codexUsageFresh()) ensureCodexUsage(bump, abort?.signal);
						limitSegs = formatCodexUsage(codexUsage());
					} else if (isExperientialModel(model)) {
						if (!experientialUsageFresh()) ensureExperientialUsage(bump, abort?.signal);
						limitSegs = formatExperientialUsage(experientialUsage());
					}
					if (limitSegs.length) {
						const dot: Seg = [C.sep, " · "];
						parts.push(
							limitSegs.flatMap((s, i) => {
								const seg: Seg = [usageColor(s.color, i), s.text];
								return i ? [dot, seg] : [seg];
							}),
						);
					}

					// Session cost
					const cost = sessionCost(ctx);
					if (cost > 0) parts.push([[C.cost, `$${cost.toFixed(2)}`]]);

					// π leads the row, like the permission mode does on Claude's
					const lead = paint([C.pi, "π"]) + paint([C.sep, " · "]);
					const line = lead + renderBar({ parts, modelItem, folderItem, folderName }, Math.max(1, width - 4));
					return [truncateToWidth(line, width)];
				},
			};
		});
	});

	pi.on("session_shutdown", async () => {
		abort?.abort();
		abort = null;
		tuiRef = null;
	});

	// Re-render + refresh usage on relevant events
	pi.on("message_end", (_e, ctx) => {
		forgetContextUsage();
		maybeRefreshUsage(ctx);
		bump();
	});
	// Force a fresh pull while on a metered provider (usage moves).
	const forceRefreshUsage = (ctx: ExtensionContext) => {
		lastForcedRefresh = Date.now();
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model)) {
			cachedUsage = cachedUsage
				? { ...cachedUsage, fetchedAt: 0 }
				: null;
		}
		if (isCursorModel(model)) markCursorUsageStale();
		if (isCodexModel(model)) markCodexUsageStale();
		if (isExperientialModel(model)) markExperientialUsageStale();
		maybeRefreshUsage(ctx);
	};
	pi.on("turn_end", (_e, ctx) => {
		markGitStale();
		forgetContextUsage();
		if (Date.now() - lastForcedRefresh >= FORCE_REFRESH_MIN_MS) forceRefreshUsage(ctx);
		bump();
	});
	pi.on("agent_settled", (_e, ctx) => {
		markGitStale();
		forgetContextUsage();
		forceRefreshUsage(ctx);
		bump();
	});
	pi.on("model_select", (_e, ctx) => {
		forgetContextUsage();
		// Invalidate so switching onto a metered provider always refreshes
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model) && cachedUsage) {
			cachedUsage = { ...cachedUsage, fetchedAt: 0 };
		}
		if (isCursorModel(model)) markCursorUsageStale();
		if (isCodexModel(model)) markCodexUsageStale();
		if (isExperientialModel(model)) markExperientialUsageStale();
		maybeRefreshUsage(ctx);
		bump();
	});
	pi.on("thinking_level_select", () => bump());
}
