/**
 * delegate — isolated pi subprocess for one task.
 *
 * { task, readonly?, cwd?, model?, thinking? }
 * Parallel: issue multiple tool calls in one turn.
 * Child: PI_DELEGATE=1, --no-session, --no-skills, --no-prompt-templates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDelegateTool } from "./tool";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_DELEGATE === "1") return;
	pi.registerTool(createDelegateTool());
}
