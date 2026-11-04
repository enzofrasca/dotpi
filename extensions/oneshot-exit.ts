/**
 * One-shot pi (`-p`, `--mode json|print|text`) answers and then stays alive:
 * Cursor keeps referenced sockets, so the event loop never drains. Delegate
 * waits on that process until the parent run is discarded (5 minutes).
 * RPC and interactive sessions are left alone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GRACE_MS = 1000;

function isOneShot(argv: string[]): boolean {
	if (argv.includes("-p") || argv.includes("--print")) return true;
	const i = argv.indexOf("--mode");
	const mode = i >= 0 ? argv[i + 1] : undefined;
	return mode === "json" || mode === "print" || mode === "text";
}

function exitCode(messages: ReadonlyArray<{ role?: string; stopReason?: string }>): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		return message.stopReason === "error" || message.stopReason === "aborted" ? 1 : 0;
	}
	return 0;
}

export default function (pi: ExtensionAPI) {
	if (!isOneShot(process.argv)) return;
	let armed = false;
	pi.on("agent_end", (event) => {
		if (armed) return;
		armed = true;
		const code = exitCode(event.messages as Array<{ role?: string; stopReason?: string }>);
		setTimeout(() => process.exit(code), GRACE_MS);
	});
}
