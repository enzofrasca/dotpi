/** Shared text helpers: redact / clip / flatten. */

export function flatten(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

const SECRET_RE =
	/(sk-[A-Za-z0-9-_]{8,}|gh[posur]_[A-Za-z0-9_]{8,}|gsk_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{10,})/g;

/** Mask secret-looking tokens. Never throws. */
export function redact(s: string): string {
	try {
		return s.replace(SECRET_RE, "[redacted]");
	} catch {
		return "[unprintable]";
	}
}

export function clip(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, Math.max(0, n - 1))}…`;
}

type TextBlock = { type: string; text?: string };

/** Text blocks plus toolCall JSON clipped to toolCallClip chars. */
export function asTextWithToolCalls(content: unknown, toolCallClip: number): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as (TextBlock & { type?: string })[])
		.map((b) => {
			if (!b || typeof b !== "object") return "";
			if (b.type === "text" && typeof b.text === "string") return b.text;
			if (b.type === "toolCall") {
				const s = JSON.stringify(b);
				return s.length > toolCallClip ? `${s.slice(0, toolCallClip)}…[truncated toolCall]` : s;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
