/**
 * ui — cosmetic terminal chrome for pi
 *
 * - footer: model, thinking, cwd, context %, Grok weekly + Cursor plan usage meters
 * - titlebar: braille spinner in the terminal tab title while the agent works
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFooter from "./footer";
import registerTitlebar from "./titlebar";

export default function (pi: ExtensionAPI) {
	// Headless `pi -p` children have no TUI; skip chrome so leftover
	// titlebar/usage timers cannot keep the process alive after the turn.
	if (process.env.PI_DELEGATE === "1") return;
	registerFooter(pi);
	registerTitlebar(pi);
}
