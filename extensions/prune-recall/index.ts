/**
 * prune-recall — stub old bulky tool results in the prompt; recall the
 * session JSONL. /compact stays the Pi verb. This extension does not write
 * the card.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolPrune } from "./prune.ts";
import { registerRecall } from "./recall.ts";

export default function (pi: ExtensionAPI): void {
	registerToolPrune(pi);
	registerRecall(pi);
}
