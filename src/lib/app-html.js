/**
 * The app preview's HTML builder.
 *
 * Builds the self-contained HTML document (with console interceptor,
 * asset/import rewriting, storage shim, and Plotly for an app that uses
 * it) that is posted to the app-preview iframe's bootloader, from the
 * files under the session's `app/`.
 */

import _iframeBridgeSource from './iframe-bridge.js?raw';
import { APP_STORAGE_QUOTA } from './app-storage.js';
import { PLOTLY_URL } from './cdn.js';
import ecosystem from 'virtual:ecosystem-packages';
import {
    buildAssetsScript,
    collectAssets,
    inlineAssets,
    rewriteCssAssetRefs,
    rewriteHtmlAssetRefs,
} from './app-assets.js';

const CONSOLE_INTERCEPTOR = `
<script>
(function() {
    // Guarded postMessage to the studio parent. The bootloader stamps
    // window.__AGEX_PARENT_ORIGIN before app scripts run; if it's
    // somehow missing, DROP the message rather than fall back to '*'
    // — app-storage contents and bridge payloads must never broadcast
    // to an arbitrary embedder. Returns whether the message was sent
    // so reply-expecting callers can fail fast instead of hanging.
    // Defined here because the console interceptor is the first
    // script in every buildAppPage assembly; later inline scripts
    // (host bridge, storage shim, control bridge) rely on it.
    window.__agexPost = function(msg) {
        var origin = window.__AGEX_PARENT_ORIGIN;
        if (!origin) return false;
        window.parent.postMessage(msg, origin);
        return true;
    };
    window.__agex_logs = [];
    var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
    // Per-message cap. Mirrors MAX_VALUE_BYTES in iframe-bridge.js:
    // an in-iframe console.log(bigObject) would otherwise flow into
    // testApp's collected logs and from there into the agent's
    // next-turn context. 50 KB per log entry stays generous for
    // useful debugging output while preventing single-log context
    // blowups.
    var MAX_LOG_BYTES = 50000;
    function capture(level, args) {
        var msg = Array.prototype.map.call(args, function(a) {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch(e) { return String(a); }
        }).join(' ');
        if (msg.length > MAX_LOG_BYTES) {
            msg = '[truncated: log was ' + msg.length + ' bytes (cap ' +
                MAX_LOG_BYTES + '). First ' + MAX_LOG_BYTES + ' bytes: ' +
                msg.slice(0, MAX_LOG_BYTES) + ']';
        }
        window.__agex_logs.push({ level: level, message: msg });
    }
    console.log = function() { capture('log', arguments); _origLog.apply(console, arguments); };
    console.warn = function() { capture('warn', arguments); _origWarn.apply(console, arguments); };
    console.error = function() { capture('error', arguments); _origErr.apply(console, arguments); };
    window.onerror = function(msg, src, line, col, err) {
        window.__agex_logs.push({ level: 'error', message: msg + (err && err.stack ? '\\n' + err.stack : '') });
    };
    window.addEventListener('unhandledrejection', function(e) {
        var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled promise rejection';
        window.__agex_logs.push({ level: 'error', message: msg });
    });

    // Capture resource-load errors (img / script / link / etc.)
    // and surface them two ways:
    //   1. Push to __agex_logs so testApp's collected logs include
    //      them — without this the agent sees only the visual symptom
    //      (page renders unstyled / image broken) and has to guess
    //      what 404'd. Agent-reported gap.
    //   2. Forward to parent for live-preview console diagnostics
    //      (see AppPreview.svelte's listener).
    // Resource-load errors don't bubble to window.onerror, so the
    // capture-phase listener is the only way to see them.
    window.addEventListener('error', function(ev) {
        var el = ev.target;
        if (!el || el === window) return;  // uncaught JS errors handled above
        try {
            var tag = el.tagName ? el.tagName.toLowerCase() : '?';
            var url = el.src || el.href || el.data || '';
            var attr = el.src ? 'src' : (el.href ? 'href' : 'data');
            var logMsg = '[resource load failed] <' + tag + ' ' + attr + '="' + String(url) + '"> failed to load';
            window.__agex_logs.push({ level: 'error', message: logMsg });
            window.__agexPost({
                type: 'agex-iframe-resource-error',
                tag: tag,
                attr: attr,
                url: String(url),
                outerHTML: (el.outerHTML || '').slice(0, 200),
            });
        } catch (_) { /* swallow */ }
    }, true);  // capture phase — resource errors don't bubble
})();
<\/script>`;

/** The page an app with `app/main.js` and no `app/index.html` gets. */
const MAIN_JS_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 1rem; }
</style>
</head><body>
<div id="app"></div>
<script type="module" src="./main.js"><\/script>
</body></html>`;

const HOST_BRIDGE_SCRIPT = `
<script>
// getCacheValue(key) — read a value the agent stashed via cache.set(key, value).
// The agent must have called cache.set on the key before the app reads it.
window.getCacheValue = function(key) {
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise(function(resolve, reject) {
        function handler(event) {
            if (event.data && event.data.type === 'agex-cache-get-result' && event.data.id === id) {
                window.removeEventListener('message', handler);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.data);
            }
        }
        window.addEventListener('message', handler);
        if (!window.__agexPost({
            type: 'agex-cache-get',
            id: id,
            key: key,
        })) {
            window.removeEventListener('message', handler);
            reject(new Error('agex parent origin not configured'));
        }
    });
};

// agex.task({ name, instructions, params, returns }) — an agent task the
// app calls: params maps each input's name to its JSON Schema, returns is
// the value's JSON Schema. The studio runs it on the viewer's model and
// resolves with the value; it rejects with what went wrong (no model
// chosen, the viewer didn't allow it, the person stopped its calls, the task
// failed). const summarize = agex.task({...}); await summarize({ text }).
// NOTE: this whole block is inside a template literal — no backticks.
window.agex = {
    task: function(spec) {
        var fn = function(inputs) {
            var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
            return new Promise(function(resolve, reject) {
                function handler(event) {
                    if (!event.data || event.data.type !== 'agex-task-result' || event.data.id !== id) return;
                    window.removeEventListener('message', handler);
                    if (event.data.error) reject(new Error(event.data.error));
                    else resolve(event.data.value);
                }
                window.addEventListener('message', handler);
                if (!window.__agexPost({ type: 'agex-task', id: id, spec: spec, inputs: inputs || {} })) {
                    window.removeEventListener('message', handler);
                    reject(new Error('agex parent origin not configured'));
                }
            });
        };
        fn.spec = spec;
        return fn;
    },
    // agex.model() — an agex-ts Provider on the viewer's model, for an
    // agent the app runs itself: new Agent({ model: agex.model(), primer }).
    // Each stream(messages, tools, settings, { signal }) is one model call
    // the studio makes on the viewer's model and key, its events (text and
    // thinking deltas, then the Reply) yielded as they arrive; aborting the
    // signal stops it in the studio too. The calls are metered and limited
    // as tasks are, and an app from elsewhere asks first. A failed call
    // rejects; transient(error) and describe(error) answer as the viewer's
    // own provider does.
    // NOTE: this whole block is inside a template literal — no backticks.
    model: function() {
        function abortError(signal) {
            var reason = signal.reason;
            if (reason instanceof Error) return reason;
            var err = new Error(typeof reason === 'string' ? reason : 'the request was cancelled');
            err.name = 'AbortError';
            return err;
        }
        return {
            name: 'agex-studio:viewer',
            stream: async function*(messages, tools, settings, opts) {
                var signal = opts && opts.signal;
                if (signal && signal.aborted) throw abortError(signal);
                var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                var queue = [];
                var ended = false;
                var failure = null;
                var wake = null;
                function nudge() {
                    if (!wake) return;
                    var w = wake;
                    wake = null;
                    w();
                }
                function handler(event) {
                    var d = event.data;
                    if (!d || d.id !== id) return;
                    if (d.type === 'agex-model-event') {
                        queue.push(d.event);
                    } else if (d.type === 'agex-model-end') {
                        ended = true;
                        if (d.error) {
                            failure = new Error(d.error.message);
                            failure.name = d.error.name || 'Error';
                            failure.agexModel = { transient: d.error.transient === true, describe: typeof d.error.describe === 'string' ? d.error.describe : null };
                        }
                    } else {
                        return;
                    }
                    nudge();
                }
                window.addEventListener('message', handler);
                if (signal) signal.addEventListener('abort', nudge);
                try {
                    if (!window.__agexPost({ type: 'agex-model', id: id, messages: messages, tools: tools || [], settings: settings || {} })) {
                        ended = true;
                        throw new Error('agex parent origin not configured');
                    }
                    for (;;) {
                        if (signal && signal.aborted) throw abortError(signal);
                        if (queue.length > 0) {
                            yield queue.shift();
                            continue;
                        }
                        if (ended) {
                            if (failure) throw failure;
                            return;
                        }
                        await new Promise(function(resolve) { wake = resolve; });
                    }
                } finally {
                    window.removeEventListener('message', handler);
                    if (signal) signal.removeEventListener('abort', nudge);
                    // stopped, or left early: the studio stops the call too
                    if (!ended) window.__agexPost({ type: 'agex-model-cancel', id: id });
                }
            },
            transient: function(error) {
                return !!(error && error.agexModel && error.agexModel.transient);
            },
            describe: function(error) {
                return error && error.agexModel ? error.agexModel.describe : null;
            },
        };
    },
};

// agex.db — the session's SQLite database, kept by the studio (forks
// share it; an undo doesn't rewind it). query(sql, params?) runs one
// statement as a transaction and resolves with { rows, changes,
// lastInsertRowid }; transaction([[sql, params?] or sql, ...]) runs
// several as one, all or none, and resolves with each one's result.
// A failure rejects with SQLite's message (or what was refused and
// what to do instead); in a transaction, err.index names the statement.
// NOTE: this whole block is inside a template literal — no backticks.
(function() {
    function call(op, args) {
        var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        return new Promise(function(resolve, reject) {
            function handler(event) {
                if (!event.data || event.data.type !== 'agex-db-result' || event.data.id !== id) return;
                window.removeEventListener('message', handler);
                var e = event.data.error;
                if (!e) { resolve(event.data.value); return; }
                var err = new Error(e.message);
                err.name = e.name || 'Error';
                if (typeof e.index === 'number') err.index = e.index;
                reject(err);
            }
            window.addEventListener('message', handler);
            if (!window.__agexPost({ type: 'agex-db', id: id, op: op, args: args })) {
                window.removeEventListener('message', handler);
                reject(new Error('agex parent origin not configured'));
            }
        });
    }
    window.agex.db = {
        query: function(sql, params) {
            if (typeof sql !== 'string') return Promise.reject(new TypeError('agex.db.query(sql, params?): sql must be a string'));
            return call('query', [sql, params == null ? null : params]);
        },
        transaction: function(statements) {
            if (!Array.isArray(statements)) return Promise.reject(new TypeError('agex.db.transaction(statements): a list of [sql, params?] (or sql strings)'));
            return call('transaction', [statements.map(function(st) { return typeof st === 'string' ? [st] : st; })]);
        },
    };
    // agex.kvStore(name?) — a kvgit KVStore kept in agex.db (table
    // _agex_kv), for a store of the app's own: Store.open(await
    // agex.kvStore()) gives an agent's world that syncs with the rest of
    // the database. Keys are strings, values Uint8Arrays; each call is
    // one transaction, so cas and casMany compare and write atomically.
    // Without a name it is the store 'default'.
    window.agex.kvStore = function(name) {
        var store = name == null ? 'default' : name;
        if (typeof store !== 'string' || store === '') throw new TypeError('agex.kvStore(name?): the name must be a non-empty string');
        function kv(method, args) {
            args = args || {};
            args.store = store;
            return call('kv', [method, args]);
        }
        return {
            get: function(key) { return kv('get', { key: key }); },
            has: function(key) { return kv('has', { key: key }); },
            set: function(key, value) { return kv('set', { key: key, value: value }); },
            remove: function(key) { return kv('remove', { key: key }); },
            getMany: function(keys) { return kv('getMany', { keys: Array.from(keys) }).then(function(items) { return new Map(items); }); },
            setMany: function(items) { return kv('setMany', { items: Array.from(items) }); },
            removeMany: function(keys) { return kv('removeMany', { keys: Array.from(keys) }); },
            cas: function(key, value, expected) { return kv('cas', { key: key, value: value, expected: expected }); },
            casMany: function(expected, writes, removes) {
                return kv('casMany', { expected: Array.from(expected), writes: Array.from(writes), removes: Array.from(removes || []) });
            },
            keys: async function*(prefix) { yield* await kv('keys', { prefix: prefix == null ? null : prefix }); },
            items: async function*(prefix) { yield* await kv('items', { prefix: prefix == null ? null : prefix }); },
            clear: function() { return kv('clear'); },
        };
    };
})();

// notify(title, body?) — show a desktop notification via the host.
// The sandbox can't construct Notifications (or ask for permission)
// itself, so the studio shows it: only once the person has allowed
// notifications in the studio's settings, and at most 5 a minute per
// session. Resolves to true when a notification was shown, false
// otherwise (not allowed, over the cap, unsupported); it never rejects,
// so check the boolean and fall back to in-page UI. Accepts either
// notify('Title', 'Body') or notify({ title, body }). Clicking the
// notification focuses the studio's tab and switches to this session.
// NOTE: this whole block is inside a template literal — no backticks.
window.notify = function(title, body) {
    var opts = (title && typeof title === 'object') ? title : { title: title, body: body };
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise(function(resolve) {
        function handler(event) {
            if (!event.data || event.data.type !== 'agex-notify-result' || event.data.id !== id) return;
            window.removeEventListener('message', handler);
            // why not, for whoever reads the console
            if (!event.data.shown && event.data.error) console.info('notify: not shown: ' + event.data.error);
            resolve(!!event.data.shown);
        }
        window.addEventListener('message', handler);
        if (!window.__agexPost({
            type: 'agex-notify',
            id: id,
            title: opts.title == null ? '' : String(opts.title),
            body: opts.body == null ? '' : String(opts.body),
        })) {
            // notify() never rejects — treat "can't reach parent" as
            // "not shown".
            window.removeEventListener('message', handler);
            resolve(false);
        }
    });
};

// agex.busy(promise) — mark work in flight that a reload would cut off
// (an agent's turn, an import). While any is, a sync that brings another
// device's changes to agex.db offers the person a reload instead of
// reloading the app; a restore of the database still reloads it. Returns
// the promise it was given, so await agex.busy(turn()) reads as
// await turn(). Calls may overlap; a rejection settles the work as a
// resolve does, and is still the caller's to catch.
// NOTE: this whole block is inside a template literal — no backticks.
(function() {
    var pending = 0;
    function report() {
        try {
            window.__agexPost({ type: 'agex-busy', busy: pending });
        } catch (e) { /* parent gone — swallow */ }
    }
    function settled() {
        pending -= 1;
        report();
    }
    window.agex.busy = function(work) {
        pending += 1;
        report();
        Promise.resolve(work).then(settled, settled);
        return work;
    };
})();
<\/script>`;

/**
 * Build the localStorage/sessionStorage/indexedDB shim script tag,
 * with the branch's current app-storage dict baked into the HTML so
 * the shim is synchronously seeded before app modules execute.
 *
 * `writeable=true` makes the shim post `agex-app-storage` messages on
 * every mutation; the parent debounces and persists them. Pass
 * `false` for ephemeral iframes (e.g. test_app) that shouldn't write
 * back to the session. A test's page passes `report: true` too: each
 * change to either store posts `agex-test-storage` with both bags, a
 * message only the test listens for, so its `{reload: true}` can seed
 * the next page with what this one wrote (`sessionSeed` seeds
 * `sessionStorage`, which a reload keeps in a browser's tab).
 *
 * @param {{ seed?: Record<string,string>, writeable?: boolean, report?: boolean, sessionSeed?: Record<string,string> }} [opts]
 * @returns {string}
 */
function buildAppStorageShim(opts = {}) {
    const seed = opts.seed || {};
    const writeable = opts.writeable !== false;
    const report = !writeable && opts.report === true;
    // Every `<` escaped (a JS string escape, so the values read back
    // the same): a stored `</script>` or `<!--` can't end or upset the
    // script element the seed sits in.
    const json = (/** @type {Record<string,string>} */ bag) => JSON.stringify(bag).replace(/</g, '\\u003c');
    return `
<script>
(function() {
    var __seed = ${json(seed)};
    var __sessionSeed = ${json(opts.sessionSeed || {})};
    var __writeable = ${writeable};
    var __report = ${report};
    var QUOTA = ${APP_STORAGE_QUOTA};
    // each store's contents, kept off the store the app sees
    var snapshots = {};

    function reportBags() {
        try {
            window.__agexPost({
                type: 'agex-test-storage',
                local: snapshots.local(),
                session: snapshots.session(),
            });
        } catch (e) { /* parent gone — swallow */ }
    }

    function buildStore(name, persist, seed) {
        var data = Object.assign({}, seed || {});
        snapshots[name] = function() { return Object.assign({}, data); };
        function size() {
            try { return JSON.stringify(data).length; } catch (e) { return 0; }
        }
        function notify() {
            if (__report) return reportBags();
            if (!persist || !__writeable) return;
            try {
                window.__agexPost({
                    type: 'agex-app-storage',
                    data: JSON.parse(JSON.stringify(data)),
                });
            } catch (e) { /* parent gone — swallow */ }
        }
        return {
            get length() { return Object.keys(data).length; },
            key: function(i) {
                var k = Object.keys(data);
                return i >= 0 && i < k.length ? k[i] : null;
            },
            getItem: function(k) {
                var s = String(k);
                return Object.prototype.hasOwnProperty.call(data, s) ? data[s] : null;
            },
            setItem: function(k, v) {
                var sk = String(k), sv = String(v);
                var had = Object.prototype.hasOwnProperty.call(data, sk);
                var prev = data[sk];
                data[sk] = sv;
                if (size() > QUOTA) {
                    if (had) data[sk] = prev; else delete data[sk];
                    var err = new Error('app storage quota exceeded (' + QUOTA + ' bytes)');
                    err.name = 'QuotaExceededError';
                    throw err;
                }
                notify();
            },
            removeItem: function(k) {
                var sk = String(k);
                if (Object.prototype.hasOwnProperty.call(data, sk)) {
                    delete data[sk];
                    notify();
                }
            },
            clear: function() {
                if (Object.keys(data).length === 0) return;
                data = {};
                notify();
            },
        };
    }

    function install(name, store) {
        try {
            Object.defineProperty(window, name, {
                value: store, configurable: true, writable: false, enumerable: true,
            });
        } catch (e) {
            try { window[name] = store; } catch (_) { /* give up */ }
        }
    }

    install('localStorage', buildStore('local', true, __seed));
    install('sessionStorage', buildStore('session', false, __sessionSeed));

    // IndexedDB is not supported inside agex artifacts. Stub every
    // access with a clear error so agents see the contract violation
    // immediately rather than debugging a silent no-op.
    var idbErr = function() {
        throw new Error('IndexedDB is not supported in agex apps: use agex.db (SQLite: agex.db.query, agex.db.transaction) for data, or localStorage for small settings');
    };
    var idbStub = new Proxy(function() { idbErr(); }, {
        get: function() { return idbErr; },
        apply: idbErr,
        construct: idbErr,
    });
    install('indexedDB', idbStub);
})();
<\/script>`;
}

// Agent control bridge — receives postMessage action commands from the
// parent (click/type/read/eval/screenshot/get-logs) and dispatches them
// against the iframe's own DOM. The app runs at the apps origin, a
// different origin from the studio's, so the studio can't reach into
// its document and drives it through this bridge instead. The dispatch
// logic lives in ./iframe-bridge.js; this is just the inline-module
// shim that carries it as text and wires it to the iframe's window.
const AGENT_CONTROL_BRIDGE_SCRIPT = `
<script type="module">
${_iframeBridgeSource}
installControlBridge(window);
// Signal the parent that the iframe is past document parse and the
// control bridge is installed, so it can take actions. Module scripts
// run in order once the document parses, and this one has no imports,
// so it runs first: the app's own modules may still be fetching theirs.
window.__agexPost({ type: 'agex-bridge-ready' });
// And once the document's load event fires: after the app's module
// scripts ran, their static imports fetched (from esm.sh, a cold one
// can take seconds), and its images and styles loaded. test_app waits
// for it before the first action. Only the event says so: a page
// written in by document.open() reads readyState 'complete' throughout,
// and this module runs before the document's load.
window.addEventListener('load', () => window.__agexPost({ type: 'agex-page-loaded' }), { once: true });
<\/script>`;

const CDN_IMPORTS = {
    "preact": "https://esm.sh/preact@10.25.4",
    "preact/": "https://esm.sh/preact@10.25.4/",
    // htm: JSX-like template literals without a build step. Tiny
    // (~3KB) and the standard "JSX without esbuild" companion to
    // preact. Its subpaths (`htm/preact`) come with their own
    // dependencies left as bare imports (esm.sh's `*` prefix), so
    // `preact` and `htm` resolve through this map to the pinned
    // copies: one Preact on the page, whose hooks work with
    // `htm/preact`'s `render`.
    "htm": "https://esm.sh/htm@3.1.1",
    "htm/": "https://esm.sh/*htm@3.1.1/",
    // Alias 'react' → preact/compat so agent code that writes
    // idiomatic React (`import { useState } from 'react'`) runs on
    // the lighter Preact runtime.  Most React component libraries
    // (radix, recharts, react-aria, etc.) work transparently this way.
    //
    // Note the per-subpath split: 'react-dom/client' (the React-18
    // root API exposing createRoot) maps to 'preact/compat/client',
    // a separate Preact bundle.  Pointing it at plain 'preact/compat'
    // produces a "no export named 'createRoot'" failure at runtime.
    "react": "https://esm.sh/preact@10.25.4/compat",
    "react-dom": "https://esm.sh/preact@10.25.4/compat",
    "react-dom/client": "https://esm.sh/preact@10.25.4/compat/client",
    "react/jsx-runtime": "https://esm.sh/preact@10.25.4/jsx-runtime",
    "marked": "https://esm.sh/marked@17.0.4",
    "dayjs": "https://esm.sh/dayjs@1.11.20",
    "dayjs/": "https://esm.sh/dayjs@1.11.20/",
    "dompurify": "https://esm.sh/dompurify@3.3.3",
    ...ecosystemImports(ecosystem),
};

/**
 * The import map's entries for agex-ts and its packages, each and each
 * of its exports' subpaths: the versions the studio is built with, so an
 * app's agent runs on what the studio does and the agex-ecosystem
 * skill's READMEs describe. Each is asked of esm.sh with the others
 * left bare, for this map to resolve, so the page has one copy of each
 * (a world's store and an agent's session have to share theirs). The
 * world's code worker comes from beside its module, and imports only
 * its own chunks.
 *
 * @param {Record<string, { version: string, subpaths: string[] }>} packages
 * @returns {Record<string, string>}
 */
export function ecosystemImports(packages) {
    const names = Object.keys(packages).sort();
    /** @type {Record<string, string>} */
    const out = {};
    for (const name of names) {
        const { version, subpaths } = packages[name];
        const external = `external=${names.filter((n) => n !== name).join(',')}`;
        out[name] = `https://esm.sh/${name}@${version}?${external}`;
        for (const sub of subpaths) out[`${name}/${sub}`] = `https://esm.sh/${name}@${version}/${sub}?${external}`;
    }
    return out;
}

/**
 * The option an auto-resolved esm.sh package is asked for with: its own
 * imports of these left bare, for the import map to resolve to
 * `CDN_IMPORTS`' pinned Preact (React aliased to it).
 */
const SHARED_RUNTIME = 'external=preact,react,react-dom';

/**
 * The esm.sh URL for a bare specifier, with `SHARED_RUNTIME` added to
 * any options it already carries (`monaco-editor?worker`).
 *
 * @param {string} spec
 */
function _sharedUrl(spec) {
    return `https://esm.sh/${spec}${spec.includes('?') ? '&' : '?'}${SHARED_RUNTIME}`;
}

/**
 * The esm.sh prefix for a package's subpaths, with `SHARED_RUNTIME`.
 * A prefix can't end in a query, so the option goes in the path, which
 * esm.sh reads only after a version: the package's own, or the latest.
 *
 * @param {string} pkg a package root, as `_packageRoot` gives it
 */
function _sharedPrefix(pkg) {
    const name = pkg.startsWith('@') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
    const versioned = name.includes('@') ? pkg : `${pkg}@latest`;
    return `https://esm.sh/${versioned}&${SHARED_RUNTIME}/`;
}

/**
 * Does the app use Plotly? It's a global the page loads from a script
 * (a few MB, render-blocking), so only a page whose own code names it
 * gets it: `Plotly.newPlot(...)`, `window.Plotly`, `typeof Plotly`, in
 * the page or any of the app's scripts.
 *
 * @param {Record<string, string>} appFiles
 * @param {string} html - the page the app is built from
 * @returns {boolean}
 */
function _usesPlotly(appFiles, html) {
    const re = /\bPlotly\b/;
    if (re.test(html)) return true;
    return Object.entries(appFiles).some(
        ([path, content]) => path.endsWith('.js') && !WORKER_FILE_RE.test(path) && re.test(content),
    );
}

/** Prefix used for bare specifiers in the import map for local app files. */
const APP_MODULE_PREFIX = '__app/';

/**
 * Is this an npm-style bare specifier (vs a relative path, absolute
 * URL, data URL, or app-local prefix)?
 *
 * @param {string} spec
 * @returns {boolean}
 */
function _isBareSpecifier(spec) {
    if (!spec) return false;
    if (spec.startsWith('.')) return false;
    if (spec.startsWith('/')) return false;
    if (spec.startsWith(APP_MODULE_PREFIX)) return false;
    if (spec.includes('://')) return false;
    if (spec.startsWith('data:')) return false;
    return true;
}

/**
 * Reduce a bare specifier to its package root.
 *
 *   'recharts'                      → 'recharts'
 *   'recharts/lib/Cell'             → 'recharts'
 *   '@radix-ui/react-dialog'        → '@radix-ui/react-dialog'
 *   '@radix-ui/react-dialog/dist/x' → '@radix-ui/react-dialog'
 *   'recharts@2.10.0'               → 'recharts@2.10.0' (esm.sh accepts versioned URL fragments)
 *   'monaco-editor?worker'          → 'monaco-editor'
 *
 * @param {string} spec
 * @returns {string}
 */
function _packageRoot(spec) {
    spec = spec.split('?')[0];
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    }
    const slash = spec.indexOf('/');
    return slash === -1 ? spec : spec.slice(0, slash);
}

/**
 * Scan JS source for bare module specifiers. Catches static
 * `import ... from 'pkg'` / `import 'pkg'` / `export ... from 'pkg'`
 * and dynamic `import('pkg')`. Returns a Set of the unique specifiers,
 * as written. Best-effort regex — false positives (e.g.
 * `from 'foo'` text inside a string literal or comment) just produce
 * unused import-map entries, which are harmless.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function _extractBareImports(source) {
    const out = new Set();
    // Static `import ... from 'spec'` / `import 'spec'` / `export ... from 'spec'`.
    // The leading `[^\w$]` prevents matching mid-identifier (e.g. `_import`).
    const staticRe =
        /(?:^|[^\w$])(?:import|export)(?:\s*[\w*{},$\s]*?\s*from)?\s*['"]([^'"]+)['"]/g;
    const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const re of [staticRe, dynamicRe]) {
        let m;
        while ((m = re.exec(source)) !== null) {
            const spec = m[1];
            if (_isBareSpecifier(spec)) out.add(spec);
        }
    }
    return out;
}

/**
 * Escape a string for use in a RegExp.
 * @param {string} s
 */
function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a relative import path against the importing file's directory.
 * "./constants.js" from "game/logic.js" → "game/constants.js"
 * "./utils/helpers.js" from "App.js" → "utils/helpers.js"
 *
 * @param {string} specifier - the relative path (after stripping "./")
 * @param {string} baseDir - directory of the importing file (e.g. "game/")
 * @returns {string} resolved relative path
 */
function _resolveRelative(specifier, baseDir) {
    if (!baseDir) return specifier;
    const parts = (baseDir + specifier).split('/');
    const resolved = [];
    for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p && p !== '.') resolved.push(p);
    }
    return resolved.join('/');
}

/**
 * Rewrite local relative import/export specifiers in JS code to use bare
 * prefixed specifiers that resolve via the import map.
 *
 * ./foo.js  → __app/foo.js
 * ./components/Bar.js → __app/components/Bar.js
 *
 * Only rewrites specifiers whose target file exists in knownFiles.
 * When baseDir is provided, relative paths are resolved against it
 * (e.g. "./constants.js" from "game/" resolves to "game/constants.js").
 *
 * @param {string} code - JS source code
 * @param {Set<string>} knownFiles - set of relative paths (e.g. "App.js", "utils/helpers.js")
 * @param {string} [baseDir=''] - directory of the importing file
 * @returns {string} rewritten code
 */
function _rewriteLocalImports(code, knownFiles, baseDir = '') {
    // Helper: try to resolve a specifier and return the knownFiles key, or null
    function resolve(specifier) {
        // Relative paths (./foo.js, ../foo.js, ../../foo.js) — resolved
        // against baseDir.  _resolveRelative handles `..` segment traversal.
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const relPath = specifier.startsWith('./') ? specifier.slice(2) : specifier;
            const resolved = _resolveRelative(relPath, baseDir);
            return knownFiles.has(resolved) ? resolved : null;
        }
        // /app/foo.js — absolute path agents sometimes use
        if (specifier.startsWith('/app/')) {
            const resolved = specifier.slice(5);
            return knownFiles.has(resolved) ? resolved : null;
        }
        return null;
    }

    // Static import/export-from: import ... from './foo.js', '../foo.js', or '/app/foo.js'
    code = code.replace(
        /((?:import|export)\s(?:[^'"]*?\s)?from\s*|import\s*)(['"])((?:\.{1,2}\/|\/app\/)[^'"]+)\2/g,
        (match, before, quote, specifier) => {
            const resolved = resolve(specifier);
            if (resolved) {
                return `${before}${quote}${APP_MODULE_PREFIX}${resolved}${quote}`;
            }
            return match;
        },
    );
    // Dynamic import: import('./foo.js'), import('../foo.js'), or import('/app/foo.js')
    code = code.replace(
        /import\s*\(\s*(['"])((?:\.{1,2}\/|\/app\/)[^'"]+)\1\s*\)/g,
        (match, quote, specifier) => {
            const resolved = resolve(specifier);
            if (resolved) {
                return `import(${quote}${APP_MODULE_PREFIX}${resolved}${quote})`;
            }
            return match;
        },
    );
    return code;
}

/**
 * Collect JS and CSS files from appFiles, build an import map with data URIs,
 * and inline CSS/script-src references in the HTML. Also rewrites binary
 * asset references (img / link / CSS url()) to data URLs when `assetUrls`
 * is non-empty.
 *
 * @param {Record<string, string>} appFiles
 * @param {string} html - the index.html content
 * @param {Record<string, string>} assetUrls - relative-path → data URL for binaries
 * @returns {{ html: string, importMap: Record<string, string> }}
 */
function _resolveAppModules(appFiles, html, assetUrls = {}) {
    // Collect non-HTML files
    const jsFiles = new Map();   // relative path → content
    const cssFiles = new Map();  // relative path → content

    for (const [path, content] of Object.entries(appFiles)) {
        const relative = path.replace(/^app\//, '');
        if (relative === 'index.html') continue;
        if (path.endsWith('.js')) {
            jsFiles.set(relative, content);
        } else if (path.endsWith('.css')) {
            cssFiles.set(relative, content);
        }
    }

    // Inline CSS: `<link ... href="./style.css">` (or `href="style.css"`,
    // no prefix) → `<style>contents</style>`. Both prefix forms are
    // valid HTML — agents commonly write the no-prefix form, and
    // without inlining the browser tries to fetch relative to the
    // iframe's blob: URL (which has no meaningful directory) and the
    // stylesheet 404s silently. The `(?:\\./)?` group makes the prefix
    // optional. The matched name is escaped, so `<link href="https://
    // fonts.googleapis.com/...">` (full external URL) doesn't match
    // any of our `cssFiles` entries and stays as a `<link>` for the
    // browser to fetch.
    //
    // Before inlining, rewrite any `url(...)` references in the CSS
    // body to point at the binary-asset data URLs. Has to happen
    // pre-inline because once it's in a `<style>` block, the
    // HTML-level rewriter only touches src/href/poster attrs (CSS
    // url() refs live inside the element body, not in attrs).
    for (const [name, content] of cssFiles) {
        const rewritten = Object.keys(assetUrls).length > 0
            ? rewriteCssAssetRefs(content, assetUrls)
            : content;
        const pattern = new RegExp(
            `<link[^>]*href=["'](?:\\./)?${_escapeRegex(name)}["'][^>]*/?>`,
            'g',
        );
        html = html.replace(pattern, () => `<style>${rewritten}</style>`);
    }

    // Build import map entries for JS files
    /** @type {Record<string, string>} - specifier → data-URL / CDN URL */
    const appImports = {};
    const knownFiles = new Set(jsFiles.keys());

    if (knownFiles.size > 0) {
        for (const [name, content] of jsFiles) {
            const dir = name.includes('/') ? name.replace(/[^/]+$/, '') : '';
            const rewritten = _rewriteLocalImports(content, knownFiles, dir);
            const encoded = encodeURIComponent(rewritten);
            appImports[APP_MODULE_PREFIX + name] = `data:text/javascript;charset=utf-8,${encoded}`;
        }

        // Rewrite imports in inline <script type="module"> blocks
        html = html.replace(
            /(<script\b[^>]*type\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
            (match, open, body, close) => {
                // Skip scripts with src attribute (handled below)
                if (/\bsrc\s*=/.test(open)) return match;
                return open + _rewriteLocalImports(body, knownFiles) + close;
            },
        );

        // Replace <script type="module" src="./foo.js"> with import via import map
        for (const name of jsFiles.keys()) {
            const pattern = new RegExp(
                `<script([^>]*?)\\bsrc=["'](?:\\./)?${_escapeRegex(name)}["']([^>]*)>[\\s\\S]*?</script>`,
                'g',
            );
            html = html.replace(pattern, (match, before, after) => {
                if (/type\s*=\s*["']module["']/.test(before + after)) {
                    // Module script → import via import map
                    const attrs = (before + after).replace(/type\s*=\s*["']module["']\s*/g, '').trim();
                    return `<script type="module" ${attrs}>import '${APP_MODULE_PREFIX}${name}';<\/script>`;
                }
                // Non-module script → inline directly
                const attrs = (before + after).trim();
                return `<script${attrs ? ' ' + attrs : ''}>${jsFiles.get(name)}<\/script>`;
            });
        }
    }

    // Auto-resolve bare npm specifiers to esm.sh. Scan every JS file
    // plus every inline `<script type="module">` block for bare
    // imports (e.g. `import { Bar } from 'recharts'`,
    // `import * as Dialog from '@radix-ui/react-dialog'`). For each
    // package not already covered by CDN_IMPORTS, map the specifier as
    // written and its package's bare and trailing-slash forms to esm.sh.
    //
    // Every form is asked for with `SHARED_RUNTIME`: esm.sh leaves the
    // package's own imports of Preact and React bare, so they come
    // through this map to the one pinned Preact. Asked for plainly,
    // esm.sh resolves them itself: a Preact library brings a second
    // Preact (hooks and context don't reach across the two), and a
    // React one brings React. The trailing-slash form is reached by a
    // subpath built at run time, which the scan doesn't see.
    //
    // Means agents can use any npm package transparently — no studio-
    // side import-map config per library, no direct-URL imports
    // required. CDN_IMPORTS still wins on the libs we ship pinned
    // (preact aliasing, etc.) because `_buildImportMapTag` spreads
    // CDN_IMPORTS first but we filter them out here before adding to
    // `appImports`, so there's no collision either way.
    const moduleScripts = [...jsFiles.values()];
    for (const match of html.matchAll(
        /<script\b[^>]*type\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi,
    )) {
        moduleScripts.push(match[1]);
    }
    const bareSpecs = _extractBareImports(moduleScripts.join('\n'));
    for (const spec of bareSpecs) {
        const pkg = _packageRoot(spec);
        if (pkg in CDN_IMPORTS) continue;
        appImports[spec] = _sharedUrl(spec);
        appImports[pkg] ??= _sharedUrl(pkg);
        appImports[pkg + '/'] = _sharedPrefix(pkg);
    }

    // Binary-asset rewrites — applied last so they see the final
    // HTML (post CSS / script inlining). Two passes:
    //   1. HTML-level: src / href / poster attrs throughout the doc
    //      get their references swapped for data URLs.
    //   2. CSS-level: any inline `<style>` blocks (including the
    //      ones we just produced from inlining .css files) have
    //      their `url(...)` references rewritten.
    if (Object.keys(assetUrls).length > 0) {
        html = rewriteHtmlAssetRefs(html, assetUrls);
        html = html.replace(
            /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
            (_m, open, body, close) =>
                open + rewriteCssAssetRefs(body, assetUrls) + close,
        );
    }

    return { html, importMap: appImports };
}

/**
 * Build the import map script tag, merging CDN and app-local entries.
 * @param {Record<string, string>} appImports
 * @returns {string}
 */
function _buildImportMapTag(appImports) {
    const imports = { ...CDN_IMPORTS, ...appImports };
    return `<script type="importmap">${JSON.stringify({ imports })}<\/script>`;
}

/** A file is a worker entry if it ends in `.worker.js`. */
const WORKER_FILE_RE = /\.worker\.js$/;

/**
 * Bundle each `*.worker.js` app file into a self-contained ES module
 * suitable for `new Worker(url, { type: 'module' })`. Bare imports are
 * rewritten to absolute `https://esm.sh/...` URLs because a worker
 * never sees the page's import map (so the bare-specifier resolution
 * the main app relies on wouldn't work there); relative sibling files
 * bundle inline.
 *
 * Returns `{ '<path without app/ prefix>': '<bundled source>' }` —
 * an empty object (and NO esbuild load) when there are no worker
 * files, so the common worker-free app pays nothing. Throws with a
 * worker-scoped message on a build error so the agent sees which
 * worker failed and why.
 *
 * @param {Record<string, string>} appFiles
 * @returns {Promise<Record<string, string>>}
 */
export async function bundleAppWorkers(appFiles) {
    const entries = Object.keys(appFiles).filter((k) => WORKER_FILE_RE.test(k));
    if (entries.length === 0) return {};
    const { runEsbuild } = await import('./esbuild-bridge.js');
    /** @type {Record<string, string>} - worker name → bundled source */
    const out = {};
    for (const key of entries) {
        const result = await runEsbuild({
            files: appFiles,
            entryPoint: key,
            format: 'esm',
            bareImports: 'esm-url',
        });
        if (result.errors && result.errors.length > 0) {
            const msg = result.errors.map((e) => e.text || String(e)).join('; ');
            throw new Error(`worker build failed for ${key}: ${msg}`);
        }
        out[key.replace(/^app\//, '')] = result.contents ?? '';
    }
    return out;
}

/**
 * Classic <script> that exposes the bundled worker sources and a
 * `window.appWorker(name)` launcher. Runs during parse (before the
 * deferred app module scripts), so `appWorker` is defined by the time
 * app code runs. The blob URL is minted inside the frame, so the
 * worker is same-origin to the app. '' when there are no workers.
 */
function _workerRegistryScript(workerSources) {
    if (Object.keys(workerSources).length === 0) return '';
    // Escape `<` so an embedded `</script>` in bundled source can't
    // terminate this tag; `<` is a valid JS string escape.
    const json = JSON.stringify(workerSources).replace(/</g, '\\u003c');
    // One Object URL per worker name, cached in the closure — repeated
    // appWorker(name) calls (apps that recreate workers) reuse it
    // rather than leaking a fresh un-revoked blob URL each time.
    return (
        `<script>(function(){var S=${json};var U={};window.__agexWorkerSrc=S;` +
        `window.appWorker=function(n){var s=S[n];` +
        `if(s==null)throw new Error('appWorker: no worker named "'+n+'\" (expected an app/*.worker.js file)');` +
        `if(!U[n])U[n]=URL.createObjectURL(new Blob([s],{type:"text/javascript"}));` +
        `return new Worker(U[n],{type:"module"});};})();<\/script>`
    );
}

/**
 * Build the page for an app preview or test iframe: its HTML, with the
 * console interceptor, host bridge and CDN scripts injected, and
 * multi-file app projects resolved (JS via import map with data URIs,
 * CSS inlined); and its assets, each once, which the HTML refers to by
 * token (see `app-assets.js`: `hostInit` sends the two to the
 * bootloader, `inlineAssets` makes a page that stands alone).
 *
 * Async because any `*.worker.js` files are bundled (esbuild) into
 * self-contained module sources and exposed via `window.appWorker`.
 * Callers can pass `opts.workerSources` to supply pre-bundled sources
 * (and skip the esbuild load) — used by tests.
 *
 * @param {Record<string, string>} appFiles - map of filename → content
 * @param {{
 *   appBinaries?: Record<string, Uint8Array>,
 *   appStorage?: { seed?: Record<string,string>, writeable?: boolean, report?: boolean, sessionSeed?: Record<string,string> },
 *   workerSources?: Record<string, string>,
 * }} [opts]
 * @returns {Promise<AppPage>}
 */
export async function buildAppPage(appFiles, opts = {}) {
    const storageShim = buildAppStorageShim(opts.appStorage || {});
    const workerSources = opts.workerSources ?? (await bundleAppWorkers(appFiles));
    const workerScript = _workerRegistryScript(workerSources);
    // Collect the assets up-front so their tokens can flow into both
    // the module resolver (which rewrites HTML / inlined CSS refs) and
    // the injected script that exposes `window.appAssets` + the fetch
    // monkey-patch.
    const { urls: assetUrls, assets } = collectAssets(opts.appBinaries || {}, appFiles);
    const assetsScript = buildAssetsScript(assetUrls);
    // An app with a main script and no page gets a page that loads it,
    // built as any other: its imports resolve the same way.
    let html = appFiles['app/index.html'] || appFiles['index.html'] || MAIN_JS_PAGE;
    // Resolve multi-file references (JS import map, CSS inlining,
    // binary asset rewrites).
    const resolved = _resolveAppModules(appFiles, html, assetUrls);
    html = resolved.html;
    const importMapTag = _buildImportMapTag(resolved.importMap);
    const plotlyTag = _usesPlotly(appFiles, html) ? `\n<script src="${PLOTLY_URL}"><\/script>` : '';
    const cdnScripts = importMapTag + plotlyTag;

    // The storage shim runs before app code (and before the CDN
    // scripts below: a library might poke localStorage on import),
    // and the assets script early, so its fetch patch is in place
    // before any app JS runs.
    const injected = CONSOLE_INTERCEPTOR + storageShim + assetsScript + workerScript + HOST_BRIDGE_SCRIPT + AGENT_CONTROL_BRIDGE_SCRIPT + cdnScripts;
    return { html: _injectHead(html, injected), assets, storageShim };
}

/**
 * A built page: its HTML, its assets (which the HTML names by token),
 * and the storage shim as it appears in the HTML, for `reseedAppPage`.
 *
 * @typedef {{ html: string, assets: import('./app-assets.js').AppAsset[], storageShim: string }} AppPage
 */

/**
 * `page` with its storage shim seeded from `storage` instead: for a
 * page sent again after the app reloaded itself, which should start
 * from what the app saved since the page was built.
 *
 * @param {AppPage} page
 * @param {{ seed?: Record<string,string>, writeable?: boolean, report?: boolean, sessionSeed?: Record<string,string> }} storage
 * @returns {AppPage}
 */
export function reseedAppPage(page, storage) {
    const storageShim = buildAppStorageShim(storage);
    return { ...page, html: page.html.replace(page.storageShim, () => storageShim), storageShim };
}

/**
 * `html` with `injected` at the start of its head: just inside its
 * `<head>` tag (any case, any attributes), or with no head tag, where
 * the parser starts one: after the `<html>` tag, else after the
 * doctype. Never ahead of the doctype, which would put the page in
 * quirks mode.
 *
 * @param {string} html
 * @param {string} injected
 * @returns {string}
 */
function _injectHead(html, injected) {
    const at =
        /<head(?=[\s/>])[^>]*>/i.exec(html) ??
        /<html(?=[\s/>])[^>]*>/i.exec(html) ??
        /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i.exec(html);
    if (at === null) return injected + html;
    const end = at.index + at[0].length;
    return html.slice(0, end) + injected + html.slice(end);
}

/**
 * The page as one HTML string that stands on its own, its assets
 * written in as `data:` URLs.
 *
 * @param {Record<string, string>} appFiles
 * @param {Parameters<typeof buildAppPage>[1]} [opts]
 * @returns {Promise<string>}
 */
export async function buildAppHtml(appFiles, opts = {}) {
    return inlineAssets(await buildAppPage(appFiles, opts));
}
