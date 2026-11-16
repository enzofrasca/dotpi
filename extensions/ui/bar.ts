/**
 * Status-bar layout shared with the Claude Code mod
 * (~/.claude/mods/statusbar/hooks/register.ts):
 *
 *   π · Grok 4.7 xhigh › agent main* › 3% / 1M › 62% · 2h12m › $1.23
 *
 * "Aurora" palette: every item gets its own hue at similar lightness, so the
 * row reads as a gradient from warm (π) through violet/blue (model, context)
 * to teal/green (folder, credits). Warm amber/red stay reserved for warnings.
 * Drawn with 24-bit ANSI, not theme tokens.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

export const C = {
	pi: "#f6c177", // warm gold
	modelFrom: "#c4a7ff", // model name: lavender →
	modelTo: "#8ec5ff", //   → sky
	folder: "#6fd0c5", // teal
	branch: "#9ccf8a", // sage
	context: "#a9b8ff", // periwinkle
	window: "#6f7591", // slate
	cost: "#f4a582", // peach
	limits: ["#7ee0b5", "#8ab8ff", "#c3a0f5"], // mint, sky, lilac — one per meter
	text: "#c1c4cc",
	dim: "#7a7f99",
	arrow: "#625c80", // dusky violet ›
	sep: "#4d5066", // · and /
	warning: "#e9b452",
	error: "#f2716a",
};

// one violet→magenta ramp: more effort = more chroma
export const EFFORT: Record<string, string> = {
	minimal: "#6a6778",
	low: "#7b778b",
	medium: "#958ab9",
	high: "#bb99e3",
	xhigh: "#e38fdb",
	max: "#f471aa",
};

/** A colored run of text. */
export type Seg = [color: string, text: string];

/** pct used → default color / amber (≥50) / red (≥80). */
export function level(pct: number, base: string): string {
	return pct >= 80 ? C.error : pct >= 50 ? C.warning : base;
}

/**
 * Footer usage-segment colors → bar palette. Healthy meters take the next hue
 * of the limits ramp (mint, sky, lilac), so side-by-side meters stay apart.
 */
export function usageColor(color: string, nth: number): string {
	switch (color) {
		case "error":
			return C.error;
		case "warning":
			return C.warning;
		case "dim":
			return C.dim;
		default:
			return C.limits[nth % C.limits.length]!;
	}
}

function rgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One segment per character, blending `from` → `to` across the text. */
export function gradient(text: string, from: string, to: string): Seg[] {
	const chars = [...text];
	const a = rgb(from);
	const b = rgb(to);
	return chars.map((ch, i) => {
		const t = chars.length > 1 ? i / (chars.length - 1) : 0;
		const hex = a
			.map((v, j) => Math.round(v + (b[j]! - v) * t).toString(16).padStart(2, "0"))
			.join("");
		return [`#${hex}`, ch] as Seg;
	});
}

export function k(n: number): string {
	if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(n);
}

function width(segs: Seg[]): number {
	return segs.reduce((n, [, text]) => n + visibleWidth(text), 0);
}

/** The first `room` cells of segs. */
function cut(segs: Seg[], room: number): Seg[] {
	const out: Seg[] = [];
	for (const [color, text] of segs) {
		if (room <= 0) break;
		const chars = [...text].slice(0, room);
		out.push([color, chars.join("")]);
		room -= chars.length;
	}
	return out;
}

export function paint([hex, text]: Seg): string {
	const [r, g, b] = rgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export type BarItems = {
	parts: Seg[][];
	/** The model item, dropped after the folder on narrow rows. */
	modelItem: Seg[] | null;
	/** The full folder item (name + branch + dirty) and the name alone. */
	folderItem: Seg[] | null;
	folderName: Seg[];
};

/**
 * Joins the items with ` › ` and fits them to `room` columns. Narrow rows lose,
 * in order: the branch, the folder, the model, then whole items from the right;
 * only a last item too wide alone is cut.
 */
export function renderBar({ parts, modelItem, folderItem, folderName }: BarItems, room: number): string {
	const sep: Seg = [C.arrow, " › "];
	const join = (ps: Seg[][]) => ps.flatMap((p, i) => (i ? [sep, ...p] : p));
	const fits = (ps: Seg[][]) => width(join(ps)) <= room;
	const shrink: ((ps: Seg[][]) => Seg[][])[] = [
		(ps) => ps.map((p) => (p === folderItem ? folderName : p)),
		(ps) => ps.filter((p) => p !== folderName && p !== folderItem),
		(ps) => ps.filter((p) => p !== modelItem),
	];
	let kept = parts;
	for (const step of shrink) {
		if (fits(kept)) break;
		const next = step(kept);
		if (next.length) kept = next;
	}
	while (kept.length > 1 && !fits(kept)) kept = kept.slice(0, -1);
	const row = fits(kept) ? join(kept) : cut(join(kept), room);
	return row.map(paint).join("");
}
