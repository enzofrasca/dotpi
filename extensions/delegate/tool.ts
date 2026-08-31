import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatElapsed,
	formatUsage,
	getResultText,
	isFailed,
	lastToolPreview,
	nowMs,
	progressLine,
	runDurationMs,
	truncate,
} from "./helpers";
import { runDelegate } from "./runner";
import type { RunResult, ToolDetails } from "./types";

const Params = Type.Object({
	task: Type.String({
		description: "Self-contained task. Child has no parent history — include paths, goal, constraints, expected output.",
	}),
	readonly: Type.Optional(
		Type.Boolean({ description: "If true, child cannot edit files (investigation only)." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory override." })),
	model: Type.Optional(
		Type.String({ description: "Override model (provider/id). Omit to inherit the parent session model." }),
	),
	thinking: Type.Optional(
		Type.String({ description: "Override thinking level. Omit to inherit the parent session thinking." }),
	),
});

const DESCRIPTION = [
	"Run a task in an isolated agent (fresh context). Parent waits; only the final text returns.",
	"Use when the work would flood this conversation (multi-file recon, a scoped implementation).",
	"Prefer parent tools for small single-file work.",
	"Put everything the child needs in task. Multiple calls in one turn run in parallel.",
	"readonly: true for investigation that must not edit files.",
	"Model and thinking inherit the parent session unless overridden.",
].join(" ");

function emptyRun(task: string, readonly: boolean, startedAt: number): RunResult {
	return {
		task,
		readonly,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		startedAt,
		lastEventAt: startedAt,
	};
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Canonical `provider/id` for `pi --model`. Child processes do not inherit the session model. */
function parentModelRef(ctx: ExtensionContext): string | undefined {
	const m = ctx.model;
	if (!m?.provider || !m?.id) return undefined;
	return `${m.provider}/${m.id}`;
}

export function createDelegateTool() {
	return {
		name: "delegate",
		label: "Delegate",
		description: DESCRIPTION,
		promptSnippet: "Delegate isolated work. Put all context in task. Multiple calls run in parallel.",
		executionMode: "parallel" as const,
		parameters: Params,

		async execute(
			_id: string,
			params: {
				task?: string;
				readonly?: boolean;
				cwd?: string;
				model?: string;
				thinking?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: any) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const task = params.task?.trim() ?? "";
			const readonly = Boolean(params.readonly);
			const startedAt = nowMs();
			const makeDetails = (result: RunResult): ToolDetails => ({ result });

			if (!task) {
				return {
					content: [{ type: "text", text: "task is required." }],
					details: makeDetails(emptyRun("", readonly, startedAt)),
					isError: true,
				};
			}

			const result = await runDelegate({
				cwd: params.cwd ?? ctx.cwd,
				task,
				readonly,
				signal,
				model: params.model?.trim() || parentModelRef(ctx),
				thinking: params.thinking?.trim() || ctx.thinkingLevel,
				onUpdate: (partial) => {
					const r = partial.details?.result;
					if (!r) {
						onUpdate?.(partial);
						return;
					}
					onUpdate?.({
						content: [{ type: "text", text: progressLine(r) }],
						details: partial.details,
					});
				},
				makeDetails,
			});

			const failed = isFailed(result);
			const dur = formatElapsed(runDurationMs(result));
			const usage = formatUsage(result.usage, result.model);
			const meta = [readonly ? "readonly" : undefined, dur, usage].filter(Boolean).join(" · ");
			const body = truncate(getResultText(result));

			return {
				content: [{ type: "text", text: meta ? `${body}\n\n— ${meta}` : body }],
				details: makeDetails(result),
				isError: failed,
			};
		},

		renderCall(args: any, theme: any) {
			const tag = args.readonly ? "readonly" : "delegate";
			const preview = args.task ? clip(String(args.task), 70) : "…";
			return new Text(
				theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", tag) +
					`\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result: any, { isPartial }: any, theme: any) {
			const r = (result.details as ToolDetails | undefined)?.result;
			if (!r) {
				const c = result.content?.[0];
				return new Text(c?.type === "text" ? c.text : "(no output)", 0, 0);
			}

			const now = nowMs();
			const running = r.exitCode === -1 || isPartial;
			const failed = !running && isFailed(r);
			const icon = running
				? theme.fg("warning", "…")
				: failed
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
			const elapsed = formatElapsed(runDurationMs(r, now));
			const tag = r.readonly ? "readonly" : "delegate";
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(tag))} ${theme.fg("dim", elapsed)}`;
			if (running) {
				text += `\n${theme.fg("dim", lastToolPreview(r.messages) || "running…")}`;
			} else {
				const out = getResultText(r);
				const lines = out.split("\n");
				text += `\n${theme.fg("toolOutput", lines.slice(0, 6).join("\n"))}`;
				if (lines.length > 6) text += `\n${theme.fg("muted", `(+${lines.length - 6} lines)`)}`;
				const usage = formatUsage(r.usage, r.model);
				if (usage) text += `\n${theme.fg("dim", usage)}`;
			}
			return new Text(text, 0, 0);
		},
	};
}
