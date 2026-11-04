/**
 * ChatGPT Codex / Work usage for the footer.
 *
 * Personal Plus/Pro share a 5-hour window and a weekly window (not a monthly
 * token pool). Enterprise seats may also expose a monthly credit cap via
 * spend_control. Reads the same /wham/usage snapshot Codex uses. Tokens are
 * read-only — refresh stays with Pi / Codex CLI so we do not rotate them.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { clampPercent, formatDurationLeft } from "./format";

const PI_AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const CODEX_AUTH_PATH = join(homedir(), ".codex/auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_ERROR_TTL_MS = 60_000;

export type CodexWindow = {
	label: string;
	usedPercent: number;
	resetIso?: string;
};

export type CodexUsage = {
	plan?: string;
	windows: CodexWindow[];
	fetchedAt: number;
	error?: string;
};

export type UsageSegment = {
	text: string;
	color: "success" | "warning" | "error" | "dim" | "muted";
};

let cachedUsage: CodexUsage | null = null;
let inflight: Promise<void> | null = null;

export function isCodexModel(
	model: { provider?: string; id?: string } | undefined | null,
): boolean {
	if (!model?.provider) return false;
	return model.provider.toLowerCase().includes("openai-codex");
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		return JSON.parse(
			Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function accountIdFromAccess(access: string): string | undefined {
	const claims = decodeJwtPayload(access);
	const auth = asRecord(claims?.[JWT_CLAIM_PATH]);
	const id = auth?.chatgpt_account_id;
	return typeof id === "string" && id ? id : undefined;
}

type CodexCreds = { access: string; accountId?: string };

function readPiCodexCredentials(): CodexCreds | undefined {
	try {
		const auth = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8")) as Record<
			string,
			{ access?: string; accountId?: string } | undefined
		>;
		const entry = auth["openai-codex"];
		if (!entry?.access) return undefined;
		return {
			access: entry.access,
			accountId: entry.accountId || accountIdFromAccess(entry.access),
		};
	} catch {
		return undefined;
	}
}

function readCliCodexCredentials(): CodexCreds | undefined {
	if (!existsSync(CODEX_AUTH_PATH)) return undefined;
	try {
		const data = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as {
			tokens?: { access_token?: string; account_id?: string };
		};
		const access = data.tokens?.access_token;
		if (!access) return undefined;
		return {
			access,
			accountId: data.tokens?.account_id || accountIdFromAccess(access),
		};
	} catch {
		return undefined;
	}
}

function readCodexCredentials(): CodexCreds | undefined {
	return readPiCodexCredentials() || readCliCodexCredentials();
}

function labelFromSeconds(seconds: number): string {
	const hours = seconds / 3600;
	if (hours >= 3 && hours <= 8) return "5h";
	const days = seconds / 86400;
	if (days >= 5 && days <= 10) return "wk";
	if (days >= 25 && days <= 40) return "mo";
	if (hours < 48) return `${Math.max(1, Math.round(hours))}h`;
	return `${Math.max(1, Math.round(days))}d`;
}

function resetIsoFromWindow(raw: Record<string, unknown>): string | undefined {
	const resetAt = num(raw.reset_at ?? raw.resetsAt);
	if (resetAt) {
		const ms = resetAt > 1e12 ? resetAt : resetAt * 1000;
		return new Date(ms).toISOString();
	}
	const after = num(raw.reset_after_seconds ?? raw.resetAfterSeconds);
	if (after && after > 0) return new Date(Date.now() + after * 1000).toISOString();
	return undefined;
}

function windowSeconds(raw: Record<string, unknown>): number | undefined {
	const seconds = num(raw.limit_window_seconds ?? raw.limitWindowSeconds);
	if (seconds) return seconds;
	const mins = num(raw.window_duration_mins ?? raw.windowDurationMins);
	return mins ? mins * 60 : undefined;
}

function parseWindow(raw: unknown, fallbackLabel: string): CodexWindow | undefined {
	const rec = asRecord(raw);
	if (!rec) return undefined;
	const usedPercent = num(rec.used_percent ?? rec.usedPercent);
	if (usedPercent == null) return undefined;
	const seconds = windowSeconds(rec);
	return {
		label: seconds ? labelFromSeconds(seconds) : fallbackLabel,
		usedPercent,
		resetIso: resetIsoFromWindow(rec),
	};
}

function parseMonthly(payload: Record<string, unknown>): CodexWindow | undefined {
	const spend = asRecord(payload.spend_control ?? payload.spendControl);
	const limit = asRecord(spend?.individual_limit ?? spend?.individualLimit);
	if (!limit) return undefined;
	const usedPercent =
		num(limit.used_percent ?? limit.usedPercent) ??
		(() => {
			const used = num(limit.used);
			const total = num(limit.limit ?? limit.total);
			if (used == null || !total) return undefined;
			return (used / total) * 100;
		})();
	if (usedPercent == null) return undefined;
	return {
		label: "mo",
		usedPercent,
		resetIso: resetIsoFromWindow(limit),
	};
}

function windowsFromRateLimit(rate: Record<string, unknown> | undefined): CodexWindow[] {
	if (!rate) return [];
	const primary = parseWindow(rate.primary_window ?? rate.primaryWindow ?? rate.primary, "5h");
	const secondary = parseWindow(
		rate.secondary_window ?? rate.secondaryWindow ?? rate.secondary,
		"wk",
	);
	return [primary, secondary].filter((w): w is CodexWindow => !!w);
}

function pickCodexRateLimit(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const byId = asRecord(payload.rate_limits_by_limit_id ?? payload.rateLimitsByLimitId);
	const named = asRecord(byId?.codex);
	if (named) return named;
	return (
		asRecord(payload.rate_limit) ??
		asRecord(payload.rateLimit) ??
		asRecord(payload.rate_limits) ??
		asRecord(payload.rateLimits)
	);
}

function parseUsagePayload(payload: Record<string, unknown>): CodexUsage {
	const windows = windowsFromRateLimit(pickCodexRateLimit(payload));
	const extra = payload.additional_rate_limits ?? payload.additionalRateLimits;
	if (Array.isArray(extra)) {
		for (const item of extra) {
			const rec = asRecord(item);
			const nested = asRecord(rec?.rate_limit ?? rec?.rateLimit) ?? rec;
			for (const w of windowsFromRateLimit(nested)) {
				if (!windows.some((have) => have.label === w.label)) windows.push(w);
			}
		}
	}
	const monthly = parseMonthly(payload);
	if (monthly && !windows.some((w) => w.label === "mo")) windows.push(monthly);

	const planRaw = payload.plan_type ?? payload.planType;
	const plan = typeof planRaw === "string" ? planRaw : undefined;
	if (!windows.length) {
		return { plan, windows: [], fetchedAt: Date.now(), error: "unavailable" };
	}
	return { plan, windows, fetchedAt: Date.now() };
}

async function fetchCodexUsage(creds: CodexCreds, signal?: AbortSignal): Promise<CodexUsage> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${creds.access}`,
		Accept: "application/json",
		"User-Agent": "pi-coding-agent",
		Origin: "https://chatgpt.com",
		Referer: "https://chatgpt.com/codex/settings/usage",
	};
	if (creds.accountId) {
		headers["ChatGPT-Account-ID"] = creds.accountId;
		headers["ChatGPT-Account-Id"] = creds.accountId;
	}

	const res = await fetch(USAGE_URL, { method: "GET", headers, signal });
	if (res.status === 401 || res.status === 403) throw new Error("no-auth");
	if (!res.ok) throw new Error(`usage HTTP ${res.status}`);
	const payload = asRecord(await res.json());
	if (!payload) throw new Error("usage empty");
	return parseUsagePayload(payload);
}

export function codexUsageFresh(): boolean {
	if (!cachedUsage) return false;
	const ttl = cachedUsage.error ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS;
	return Date.now() - cachedUsage.fetchedAt < ttl;
}

export function codexUsage(): CodexUsage | null {
	return cachedUsage;
}

export function markCodexUsageStale(): void {
	if (cachedUsage) cachedUsage = { ...cachedUsage, fetchedAt: 0 };
}

export function ensureCodexUsage(onUpdate: () => void, signal?: AbortSignal): void {
	if (codexUsageFresh() || inflight) return;

	const fail = (error: string) => {
		cachedUsage = {
			windows: cachedUsage?.windows ?? [],
			plan: cachedUsage?.plan,
			fetchedAt: Date.now(),
			error,
		};
		onUpdate();
	};

	inflight = (async () => {
		const creds = readCodexCredentials();
		if (signal?.aborted) return;
		if (!creds) {
			fail("no-auth");
			return;
		}
		try {
			const usage = await fetchCodexUsage(creds, signal);
			if (signal?.aborted) return;
			cachedUsage = usage;
			onUpdate();
		} catch (err) {
			if (signal?.aborted) return;
			fail(err instanceof Error ? err.message : "error");
		}
	})().finally(() => {
		inflight = null;
	});
}

function percentColor(used: number): UsageSegment["color"] {
	if (used >= 90) return "error";
	if (used >= 75) return "warning";
	return "success";
}

function fmtRemaining(used: number): string {
	return `${clampPercent(100 - used)}%`;
}

/**
 * Remaining allowance per Codex window. Labels come from the reported duration
 * (5h / wk / mo), not from hard-coded plan lore.
 */
export function formatCodexUsage(usage: CodexUsage | null): UsageSegment[] {
	if (!usage) return [{ text: "…", color: "dim" }];
	if (usage.error === "no-auth") return [{ text: "login", color: "dim" }];
	if (usage.error || !usage.windows.length) return [{ text: "n/a", color: "dim" }];

	const segments: UsageSegment[] = [];
	for (const window of usage.windows) {
		const reset = window.resetIso ? formatDurationLeft(window.resetIso) : undefined;
		segments.push({
			text: reset
				? `${window.label} ${fmtRemaining(window.usedPercent)} · ${reset}`
				: `${window.label} ${fmtRemaining(window.usedPercent)}`,
			color: percentColor(window.usedPercent),
		});
	}
	return segments;
}
