/**
 * What every world the studio opens is given (`PROFILE`): how code runs,
 * the host objects, the terminal's commands, the skills. And what a
 * turn's tools are told beside (`toolOptionsNow`).
 */

import workerUrl from "@agex-ts/world/worker?worker&url";
import { commandFactory, wsGit } from "@agex-ts/world";
import { AGEX_GUIDE, Agent, AiSdkProvider, agentTasks } from "agex-ts";
import { runEsbuildCommand } from "./esbuild-terminal.js";
import { buildModel, thinkingOf, visionOf } from "./model.js";
import { mediaHost } from "./media.js";
import { pdfHost } from "./pdf.js";
import { scriptedNow } from "./scripted.js";
import { getSettings } from "./settings.js";
import { SKILLS } from "./skills/index.js";
import { webHost } from "./web.js";

/** `esbuild`, a terminal command: bundles JSX/TSX under app/ (and
 *  helpers/) for the preview. esbuild-wasm loads on its first use. */
const esbuild = commandFactory(
    () => async (ctx) => {
        await runEsbuildCommand(ctx, async (args) => (await import("./esbuild-bridge.js")).runEsbuild(args));
    },
    { description: "esbuild <entry> --outfile=<out>: bundle JSX/TSX under app/ into a module the preview loads (esbuild --help)" },
);

/**
 * The model agent-defined tasks run on: whatever the settings say when
 * each request goes, since one agent serves every session's tasks for
 * the page's life and the settings may change meanwhile. A provider
 * built per request from the settings now, its thinking theirs too.
 *
 * @type {import("agex-ts").Provider}
 */
const currentModel = {
    name: "agex-studio:current",
    stream(messages, tools, settings, opts) {
        const s = getSettings();
        return providerNow(s).stream(messages, tools, { ...settings, thinking: thinkingOf(s) }, opts);
    },
    transient(error) {
        return providerNow(getSettings()).transient(error);
    },
    describe(error) {
        const now = /** @type {import("agex-ts").Provider} */ (providerNow(getSettings()));
        return now.describe?.(error) ?? null;
    },
};

/** The provider the settings name now (in dev, possibly the scripted
 *  one the driver fills). @param {import("./settings.js").Settings} s */
function providerNow(s) {
    return scriptedNow(s) ?? new AiSdkProvider(buildModel(s, { session: "agex-tasks" }));
}

/**
 * `agex` in the agent's code: tasks it defines (`agex.task`) and calls,
 * each run by a helper agent on the person's model, in a scratch world
 * of its own (not a delegate: no branch, no strip, no waking).
 */
const agex = agentTasks(new Agent({ model: currentModel, settings: { maxTokens: 16000 } }), { scratch: true });

/** What a turn's tools are told, beside the world's own: whether the
 *  model takes images, and how to use `agex`. */
export function toolOptionsNow() {
    return { vision: visionOf(getSettings()), codePrimer: AGEX_GUIDE };
}

/**
 * What every world the studio opens is given: code runs in the world's
 * worker, bundled by Vite; a bare import loads from esm.sh; what code
 * puts in `ui` is written under /workspace/ui to show in the reply; the
 * studio's host objects (`web`, `media`, `pdf`, and `agex` for tasks the
 * agent's code defines); `esbuild` in the
 * terminal; and the studio's skills (`skills/`: a directory each),
 * mounted read-only under /workspace/skills.
 */
export const PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
        // `ui.chart = spec`: shown in the reply
        ui: true,
    },
    hostObjects: { web: webHost(), media: mediaHost(), pdf: pdfHost(), agex },
    // ws-git: the agent's own git, which brings a delegate's work back
    commands: { esbuild, "ws-git": wsGit },
    skills: SKILLS,
};
