/**
 * Sessions leaving the studio and coming in: bundles (exported, and
 * opened as new sessions), gists they're published to, and the newer
 * revisions of gists sessions were opened from.
 */

import { applyBundle, bundleFileName, encodeBundle, readBundleHeader } from "./bundle.js";
import { fetchGistBundle, latestRevision, parseGistParam, publishGist } from "./gist.js";
import { getSettings } from "./settings.js";
import { snapshotBranch } from "./snapshot.js";
import { PLANE, metaOf, newName, openStore } from "./store.js";
import { studio } from "./studio.svelte.js";

/** @typedef {import("./store.js").SessionSource} SessionSource */

/** @param {string} key */
function readLocal(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** @param {string} key @param {string} value */
function writeLocal(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // kept for this page only
    }
}

/** Bundles and gists, for the studio's sessions. */
export class Distribution {
    /** @type {import("./studio.svelte.js").Studio} */
    studio;

    /** @param {import("./studio.svelte.js").Studio} studio */
    constructor(studio) {
        this.studio = studio;
    }

    /**
     * Open a bundle: a new session from it, looked at; or, when an
     * earlier import of this bundle is here, that one. Its name.
     *
     * @param {Uint8Array} bytes
     * @param {{ gist?: SessionSource["gist"] }} [from] where it came from
     */
    async importBundle(bytes, from = {}) {
        const { header } = readBundleHeader(bytes);
        await this.studio.refresh();
        const known = this.studio.sessions.find((s) => s.source?.head === header.head);
        if (known !== undefined) {
            // opened from a gist now: where its updates come from
            if (from.gist !== undefined && JSON.stringify(known.source?.gist) !== JSON.stringify(from.gist)) {
                await this.#setSource(known.name, { head: header.head, gist: from.gist });
            }
            await this.studio.switchTo(known.name);
            return { name: known.name, existing: true };
        }
        const store = await openStore();
        const branch = `${newName()}.import`;
        await applyBundle(store.repo.store, bytes, branch);
        const name = await this.studio.adopt(branch, {
            title: header.title || "Imported",
            source: { head: header.head, ...(from.gist && { gist: from.gist }) },
        });
        await this.studio.switchTo(name);
        return { name, existing: false };
    }

    /** Record where session `name` came from.
     *  @param {string} name @param {SessionSource} source */
    async #setSource(name, source) {
        await this.studio.withWorkspace(name, async (ws) => {
            ws.plane(PLANE).set("source", source);
            await ws.autoCommit({ tool: "studio.source" });
        });
        await this.studio.refresh();
    }

    /**
     * Session `name` as a bundle: `everything` (its history) or `current`
     * (as it is now; see `snapshot.js`), with the title it carries. What
     * a turn left pending here is committed first.
     *
     * @param {string} name @param {"everything" | "current"} shape
     */
    async exportBundle(name, shape) {
        const store = await openStore();
        const open = this.studio.opened(name)?.ws;
        if (open?.uncommitted) await open.commit({ tool: "studio.export" });
        // the title as the session holds it (the list may not have caught up)
        const view = await store.resolve(name);
        const title = (await metaOf(view)).title || "Untitled";
        await view.close();
        const head = await store.repo.branches.get(name);
        const kv = store.repo.store;
        let bytes;
        if (shape === "current") {
            const snap = `${name}.snapshot-${Math.random().toString(36).slice(2, 8)}`;
            try {
                bytes = await encodeBundle(kv, await snapshotBranch(store, head, snap, { session: name }), { title, shape });
            } finally {
                await store.repo.branches.delete(snap).catch(() => undefined);
            }
        } else {
            bytes = await encodeBundle(kv, head, { title, shape });
        }
        return { bytes, fileName: bundleFileName(title), title };
    }

    /**
     * Publish session `name` as a gist (see `gist.js`): `shape` as for a
     * bundle; to the gist it was published to before unless `fresh`. The
     * gist is recorded on the session, and the commit published is
     * tagged in the store, `published/<slug>/<version>`. What came of it.
     *
     * @param {string} name
     * @param {{ shape: "everything" | "current", fresh?: boolean }} opts
     */
    async publish(name, { shape, fresh = false }) {
        const s = getSettings();
        const token = s.publishToken.trim() || s.syncToken.trim();
        if (token === "") throw new Error("publishing needs a GitHub token with gist access: add one in settings");
        const prior = fresh ? null : await this.published(name);
        const { bytes, title } = await this.exportBundle(name, shape);
        const gist = await publishGist({ token, title, bytes, existing: prior });
        const store = await openStore();
        await this.studio.withWorkspace(name, async (ws) => {
            // the commit published, tagged as this slug's next version
            const prefix = `published/${gist.slug}/`;
            const versions = [...(await store.tags.list()).keys()].filter((t) => t.startsWith(prefix)).length;
            await store.tags.add(ws, `${prefix}${versions + 1}`, {
                info: { gist: { owner: gist.owner, id: gist.id, revision: gist.revision }, shape, session: name, title },
            });
            ws.plane(PLANE).set("published", { owner: gist.owner, id: gist.id, slug: gist.slug, revision: gist.revision, shape, session: name, at: Date.now() });
            await ws.autoCommit({ tool: "studio.publish", gist: gist.id });
        });
        this.studio.opened(name)?.onMeta();
        return { ...gist, size: bytes.length };
    }

    /**
     * The gist session `name` was published to, if it was, from here
     * or a device it synced from (a fork's record is its parent's, and
     * doesn't count).
     *
     * @param {string} name
     * @returns {Promise<import("./gist.js").GistRef | null>}
     */
    async published(name) {
        const store = await openStore();
        const view = await store.resolve(name);
        try {
            const record = /** @type {any} */ (await view.plane(PLANE).get("published"));
            return record?.session === name ? { owner: record.owner, id: record.id, slug: record.slug, revision: record.revision } : null;
        } finally {
            await view.close();
        }
    }

    /**
     * Open a published session from its `?gist=` value: a new session
     * from the gist's bundle, looked at, or the one an earlier opening
     * of the same bundle made. Its name.
     *
     * @param {string} param
     */
    async openGist(param) {
        const ref = parseGistParam(param);
        if (ref === null) throw new Error(`"${param}" isn't a link to a published session`);
        // the revision first, then its bytes, so the revision recorded (where
        // update checks start from) is the one opened; when GitHub's API
        // can't say (rate-limited), the latest file, its revision unknown
        const revision = ref.revision ?? (await latestRevision(ref.id).catch(() => null));
        const bytes = await fetchGistBundle({ ...ref, revision });
        return this.importBundle(bytes, { gist: { owner: ref.owner, id: ref.id, slug: ref.slug, revision: revision ?? "", pinned: ref.revision !== null } });
    }

    /** Opened gists with a newer revision: session name → revision. */
    /** @type {Record<string, string>} */
    updates = $state({});

    /**
     * Look for newer revisions of the gists sessions were opened from
     * (not those opened at one revision): each gist at most every 12
     * hours unless `force`, and a revision the person dismissed stays
     * dismissed.
     *
     * @param {{ force?: boolean }} [opts]
     */
    async checkUpdates({ force = false } = {}) {
        const s = getSettings();
        const token = s.publishToken.trim() || s.syncToken.trim() || undefined;
        for (const info of this.studio.sessions) {
            const gist = info.source?.gist;
            if (gist === undefined || gist.pinned) continue;
            const key = `agex-gist-checked-${gist.id}`;
            const last = Number(readLocal(key) ?? 0);
            if (!force && Date.now() - last < 12 * 3600 * 1000) continue;
            try {
                const latest = await latestRevision(gist.id, { ...(token && { token }) });
                writeLocal(key, String(Date.now()));
                if (latest !== null && latest !== gist.revision && readLocal(`agex-gist-ignored-${info.name}`) !== latest) {
                    this.updates[info.name] = latest;
                }
            } catch {
                // offline, or rate-limited: the next look tries again
            }
        }
    }

    /**
     * Bring session `name` up to its gist's newer revision: the new one
     * opens as a session; the old one goes if nothing was done in it
     * since it was opened, else it stays beside the new.
     *
     * @param {string} name
     */
    async update(name) {
        const info = this.studio.sessions.find((x) => x.name === name);
        const gist = info?.source?.gist;
        const latest = this.updates[name];
        if (gist === undefined || latest === undefined) return;
        const bytes = await fetchGistBundle({ ...gist, revision: latest });
        const store = await openStore();
        const view = await store.resolve(name);
        const untouched = (await view.log({ limit: 1 }))[0]?.info?.tool === "studio.adopt";
        await view.close();
        await this.importBundle(bytes, { gist: { ...gist, revision: latest } });
        delete this.updates[name];
        if (untouched && this.studio.current?.name !== name) await this.studio.remove(name);
    }

    /** Don't offer this revision of session `name`'s gist again. @param {string} name */
    dismissUpdate(name) {
        const latest = this.updates[name];
        if (latest !== undefined) writeLocal(`agex-gist-ignored-${name}`, latest);
        delete this.updates[name];
    }

}

/** This page's. */
export const distribution = new Distribution(studio);
