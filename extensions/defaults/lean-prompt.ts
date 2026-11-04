/**
 * Lean the always-on parent system prompt.
 * Kill switch: PI_LEAN_PROMPT=0. Skipped for PI_DELEGATE children and custom --system-prompt.
 *
 * Edits the structured systemPromptOptions in place instead of regex-rewriting
 * the rendered prompt: Pi (>= 1.4) renders the prompt as XML-wrapped sections
 * and diffs them per turn, so mutating sections keeps the prompt cache warm and
 * can't eat neighbouring sections (<skills>, <cwd>) the way a regex could.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

// Defense only: search/scrape/delegate policy lives on tool descriptions,
// not always-on rules. Keep stripping if something re-injects them.
const DROP_PREFIXES = [
	"Use search ",
	"Use scrape",
	"Use subagents",
	"Call subagents",
	"Prefer a single subagents",
	"Use delegate",
	"Call delegate",
	"Delegate isolated",
	"Prefer search first",
	"Write queries as specific",
	"For framework or product docs",
	"Answer from search excerpts",
	"When search offers both HTML",
];

const STYLE_RULE = "Match the surrounding code's style, naming, and comment density";

const keep = (rule: string) => !DROP_PREFIXES.some((p) => rule.trim().startsWith(p));

export function registerLeanPrompt(pi: ExtensionAPI): void {
	if (process.env.PI_DELEGATE === "1") return;
	if (process.env.PI_LEAN_PROMPT === "0") return;

	pi.on("before_agent_start", async (event) => {
		const opts = event.systemPromptOptions;
		if (!opts || opts.customPrompt || opts.forceSystemPrompt !== undefined) return;

		// Replace the built-in <docs> block with a one-liner.
		opts.sections.docs =
			`Pi product docs (only when the user asks about pi itself): ${getReadmePath()}; docs ${getDocsPath()}; examples ${getExamplesPath()}.`;

		for (const [tool, rules] of Object.entries(opts.toolGuidelines)) {
			opts.toolGuidelines[tool] = rules.filter(keep);
		}
		const custom = opts.promptGuidelines.filter(keep);
		if (!custom.includes(STYLE_RULE)) custom.push(STYLE_RULE);
		opts.promptGuidelines.splice(0, opts.promptGuidelines.length, ...custom);
	});
}
