/**
 * ui — cosmetic terminal chrome for pi
 *
 * - footer: model › folder branch › context › plan limits › cost (same look as the Claude Code statusbar mod)
 *
 * The terminal title (the session's name, else the folder) is session-name/'s.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFooter from "./footer";

export default function (pi: ExtensionAPI) {
	// Headless `pi -p` children have no TUI; skip chrome so leftover
	// usage timers cannot keep the process alive after the turn.
	if (process.env.PI_DELEGATE === "1") return;
	registerFooter(pi);
}
