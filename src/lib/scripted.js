/**
 * The scripted model, in dev builds: the driver (`dev-hook.js`) fills
 * its script, and the studio runs on it while the settings choose the
 * scripted service. Every model the studio builds (turns, tasks the
 * agent's code defines, app tasks) asks here first.
 */

import { ScriptedProvider } from "agex-ts";

/** The scripted model's steps, in dev builds: set by the driver. */
/** @type {import("@agex-ts/world/conformance").ModelStep[]} */
export const script = [];

/** The scripted model's reply once its script is spent.
 *  @type {import("@agex-ts/world/conformance").ModelStep} */
const RAN_OUT = { kind: "model", text: "(the script ran out)", thinking: "", tool_calls: [], fail: "", input_tokens: 0 };

/** The scripted model, when this is a dev build and the settings choose
 *  it; else null. @param {import("./settings.js").Settings} s */
export function scriptedNow(s) {
    return s.accessMode === "scripted" && import.meta.env.DEV ? new ScriptedProvider(() => script.shift() ?? RAN_OUT) : null;
}
