import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunResult {
	task: string;
	readonly: boolean;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	startedAt: number;
	lastEventAt: number;
	endedAt?: number;
}

export interface ToolDetails {
	result: RunResult;
}

export type OnUpdate = (partial: AgentToolResult<ToolDetails>) => void;
