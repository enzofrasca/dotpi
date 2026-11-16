/**
 * Experiential (api.experientiallabs.ai) credits for the footer.
 *
 * Two numbers, both read with the ordinary xpl_ inference key:
 *   - wallet balance → GET /api/v1/credits  (total_credits - total_usage, USD)
 *   - free used today → GET /api/gateway/usage/daily?group_by=day_model, today's
 *     `free_nano_usd` summed over plan-included models only — those that ran
 *     fully free on some recent day (UTC day; the
 *     allowance resets at 00:00 UTC). Matches the dashboard's "88 / 700 credits".
 *
 * The plan's daily free allowance itself is not readable with an inference
 * key (plan routes answer 401), so it comes from EXPLABS_DAILY_FREE_CREDITS
 * (credits, 1 credit = $0.01; Pro 700, Max 7000, Ultra 70000). Default: 700.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatDurationLeft } from "./format";

const API = "https://api.experientiallabs.ai";
const ENV_PATH = join(homedir(), ".pi", "agent", ".env");
const KEY_ENV = "EXPLABS_API_KEY";
const ALLOWANCE_ENV = "EXPLABS_DAILY_FREE_CREDITS";
const DEFAULT_DAILY_FREE_CREDITS = 700;
const USAGE_TTL_MS = 2 * 60_000;
const USAGE_ERROR_TTL_MS = 60_000;

export type ExperientialUsage = {
	/** Wallet balance left, USD. */
	balanceUsd: number;
	/** Free (plan/promo) value consumed today (UTC), USD. */
	freeUsedTodayUsd: number;
	/** Daily free allowance, USD. */
	freeAllowanceUsd: number;
	/** Next 00:00 UTC. */
	resetIso: string;
	fetchedAt: number;
	error?: string;
};

export type UsageSegment = {
	text: string;
	color: "success" | "warning" | "error" | "dim" | "muted";
};

let cachedUsage: ExperientialUsage | null = null;
let inflight: Promise<void> | null = null;
let orgId: string | undefined;

export function isExperientialModel(
	model: { provider?: string; id?: string } | undefined | null,
): boolean {
	return !!model?.provider && model.provider.toLowerCase().includes("experiential");
}

function readDotEnv(name: string): string | undefined {
	if (!existsSync(ENV_PATH)) return undefined;
	for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
		const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m || m[1] !== name) continue;
		let v = m[2]!.trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		} else {
			v = v.replace(/\s+#.*$/, "");
		}
		return v || undefined;
	}
	return undefined;
}

function envValue(name: string): string | undefined {
	return process.env[name]?.trim() || readDotEnv(name)?.trim();
}

function dailyAllowanceUsd(): number {
	const credits = Number(envValue(ALLOWANCE_ENV));
	return (Number.isFinite(credits) && credits >= 0 ? credits : DEFAULT_DAILY_FREE_CREDITS) / 100;
}

function nextUtcMidnightIso(now = new Date()): string {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	).toISOString();
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function getJson(path: string, key: string, signal?: AbortSignal): Promise<any> {
	const res = await fetch(`${API}${path}`, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal,
	});
	if (res.status === 401 || res.status === 403) throw new Error("no-auth");
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** How far back to look for days a model ran entirely free. */
const INCLUDED_LOOKBACK_DAYS = 7;
const INCLUDED_TTL_MS = 60 * 60_000;

/**
 * Models seen running entirely free (plan-included). Kept across refreshes so
 * a model stays counted on the day its allowance runs out and it starts
 * billing credits.
 */
const includedModels = new Set<string>();
let includedFetchedAt = 0;

function utcDay(offsetDays = 0, now = new Date()): string {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays),
	).toISOString().slice(0, 10);
}

/**
 * One day's per-model rollup. The endpoint caps a response at 25 rows sorted
 * by paid spend (no pagination), so a multi-day range drops the $0 rows we
 * need first — always ask for a single day.
 */
async function dayModelRows(key: string, day: string, signal?: AbortSignal): Promise<any[]> {
	const res = await getJson(
		`/api/gateway/usage/daily?org_id=${encodeURIComponent(orgId!)}&scope=org&group_by=day_model&from=${day}&to=${day}`,
		key,
		signal,
	);
	const rows: any[] = Array.isArray(res?.rows) ? res.rows : [];
	return rows.filter((r) => r?.day === day);
}

function noteIncluded(rows: any[]): void {
	for (const row of rows) {
		const free = num(row?.free_nano_usd) ?? 0;
		const paid = num(row?.paid_nano_usd) ?? 0;
		if (free > 0 && paid === 0 && row?.alias) includedModels.add(String(row.alias));
	}
}

async function refreshIncludedModels(key: string, signal?: AbortSignal): Promise<void> {
	if (Date.now() - includedFetchedAt < INCLUDED_TTL_MS) return;
	const days = Array.from({ length: INCLUDED_LOOKBACK_DAYS }, (_, i) => utcDay(-(i + 1)));
	const results = await Promise.allSettled(days.map((d) => dayModelRows(key, d, signal)));
	let ok = false;
	for (const r of results) {
		if (r.status !== "fulfilled") continue;
		noteIncluded(r.value);
		ok = true;
	}
	// All failed (offline, outage): retry on the next refresh, not in an hour.
	if (ok) includedFetchedAt = Date.now();
}

async function fetchExperientialUsage(key: string, signal?: AbortSignal): Promise<ExperientialUsage> {
	const fetchedAt = Date.now();

	const creditsP = getJson("/api/v1/credits", key, signal);
	// Started before awaits that may throw; without this an early throw leaves it
	// rejecting unobserved, which kills pi. It is still awaited below.
	creditsP.catch(() => {});

	if (!orgId) {
		const who = await getJson("/api/whoami", key, signal);
		orgId = typeof who?.org_id === "string" ? who.org_id : undefined;
	}

	let freeUsedTodayUsd = 0;
	if (orgId) {
		try {
			const [rows] = await Promise.all([
				dayModelRows(key, utcDay(), signal),
				refreshIncludedModels(key, signal),
			]);
			// `free_nano_usd` mixes two things: plan-included models (fully free,
			// draw on the daily allowance) and plan discounts on paid models (e.g.
			// a flat 75% off — not allowance). Only the former count.
			noteIncluded(rows);
			for (const row of rows) {
				if (!includedModels.has(String(row?.alias ?? ""))) continue;
				freeUsedTodayUsd += (num(row?.free_nano_usd) ?? 0) / 1e9;
			}
		} catch (err) {
			if (signal?.aborted) throw err;
			// balance is still worth showing
		}
	}

	const credits = await creditsP;
	const total = num(credits?.data?.total_credits) ?? 0;
	const used = num(credits?.data?.total_usage) ?? 0;

	return {
		balanceUsd: total - used,
		freeUsedTodayUsd,
		freeAllowanceUsd: dailyAllowanceUsd(),
		resetIso: nextUtcMidnightIso(),
		fetchedAt,
	};
}

export function experientialUsageFresh(): boolean {
	if (!cachedUsage) return false;
	const ttl = cachedUsage.error ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS;
	return Date.now() - cachedUsage.fetchedAt < ttl;
}

export function experientialUsage(): ExperientialUsage | null {
	return cachedUsage;
}

export function markExperientialUsageStale(): void {
	if (cachedUsage) cachedUsage = { ...cachedUsage, fetchedAt: 0 };
}

export function ensureExperientialUsage(onUpdate: () => void, signal?: AbortSignal): void {
	if (experientialUsageFresh() || inflight) return;

	const fail = (error: string) => {
		cachedUsage = {
			balanceUsd: cachedUsage?.balanceUsd ?? 0,
			freeUsedTodayUsd: cachedUsage?.freeUsedTodayUsd ?? 0,
			freeAllowanceUsd: dailyAllowanceUsd(),
			resetIso: nextUtcMidnightIso(),
			fetchedAt: Date.now(),
			error,
		};
		onUpdate();
	};

	inflight = (async () => {
		const key = envValue(KEY_ENV);
		if (!key) {
			fail("no-auth");
			return;
		}
		try {
			const usage = await fetchExperientialUsage(key, signal);
			if (signal?.aborted) return;
			cachedUsage = usage;
			onUpdate();
		} catch (err) {
			if (signal?.aborted) return;
			fail(err instanceof Error ? err.message : "error");
		}
	})()
		// A throw outside the inner try would otherwise be an unhandled rejection.
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
}

/** USD → credits, as the dashboard counts them (1 credit = $0.01). */
function credits(usd: number): string {
	return Number.isFinite(usd) ? String(Math.round(usd * 100)) : "?";
}

/** `2887 cr · free 88/700 · 9h` — credits left, plan-included credits used today, time to reset. */
export function formatExperientialUsage(usage: ExperientialUsage | null): UsageSegment[] {
	if (!usage) return [{ text: "…", color: "dim" }];
	if (usage.error === "no-auth") return [{ text: "no key", color: "dim" }];
	if (usage.error) return [{ text: "n/a", color: "dim" }];

	const balanceColor: UsageSegment["color"] =
		usage.balanceUsd <= 1 ? "error" : usage.balanceUsd <= 5 ? "warning" : "success";

	const segments: UsageSegment[] = [
		{ text: `${credits(usage.balanceUsd)} cr`, color: balanceColor },
	];

	if (usage.freeAllowanceUsd > 0) {
		const left = Math.max(0, usage.freeAllowanceUsd - usage.freeUsedTodayUsd);
		const frac = left / usage.freeAllowanceUsd;
		// Credits used / allowance, same as the dashboard (1 credit = $0.01).
		const usedCredits = Math.round(usage.freeUsedTodayUsd * 100);
		const allowanceCredits = Math.round(usage.freeAllowanceUsd * 100);
		segments.push({
			text: `free ${usedCredits}/${allowanceCredits}`,
			color: frac <= 0.1 ? "error" : frac <= 0.25 ? "warning" : "success",
		});
		// Reset countdown matters once the free pool is getting thin.
		if (frac <= 0.25) segments.push({ text: formatDurationLeft(usage.resetIso), color: "dim" });
	}
	return segments;
}
