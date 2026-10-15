/**
 * The record's runs, read again (at a turn's end, an undo, a sync):
 * each run that hasn't changed keeps the object the chat already has,
 * so what's drawn from it (its reply's Markdown, its embeds) isn't
 * drawn again. A run is only ever added to, and its status set, so its
 * message count, last message and status say whether it changed.
 *
 * @template {import("agex-ts").Run} R
 * @param {readonly R[]} before
 * @param {R[]} fresh
 * @returns {R[]}
 */
export function keepUnchanged(before, fresh) {
    const had = new Map(before.map((r) => [r.runId, r]));
    return fresh.map((r) => {
        const old = had.get(r.runId);
        const same =
            old !== undefined &&
            old.status === r.status &&
            old.messages.length === r.messages.length &&
            old.messages.at(-1)?.id === r.messages.at(-1)?.id;
        return same ? old : r;
    });
}
