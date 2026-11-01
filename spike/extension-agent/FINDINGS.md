# Spike: agex-ts inside the extension, with no studio tab

Run 2026-11-01 in Playwright's Chromium (1228, headless), from
`spike/extension-agent` (`node build.mjs && node run.mjs`). Question: can
an extension host the agent itself, for a headless job, with no
agex.studio tab open?

**Yes.** A scripted agex-ts turn ran two `run_ts` calls through the
world's kernel (typed TypeScript, `fs.write`, an esm.sh import), the
session's store kept in the extension's IndexedDB, read back by a fresh
store after the offscreen document was closed and made again.

## The shape that worked

```text
service worker ──▶ offscreen document (extension origin)
                     IndexedDB: the store (kvgit's backend)
                     │ postMessage: kv ops, files
                     ▼
                   sandboxed iframe (manifest "sandbox"; origin "null")
                     agex-ts Agent + world Store over a KV that asks the parent
                     the kernel's worker: a classic worker from a blob
                     fetch: the model provider, esm.sh imports
```

## Measured

| Where | Probe | Result |
|---|---|---|
| offscreen doc | `new Function` | refused: `script-src 'self'` (extension pages can't eval) |
| | IndexedDB | works (kvgit's `IndexedDB` backend) |
| | fetch openrouter.ai (host permission) | 200 |
| sandbox page | `new Function` | works |
| | IndexedDB | refused: "access to the Indexed Database API is denied in this context" |
| | `chrome.*` | none |
| | classic worker from a blob URL | works |
| | **module worker from a blob URL** | **fails** (what the world asks for) |
| | eval and `import()` in a classic blob worker | works |
| | `import("https://esm.sh/...")` | works |
| | model request (POST, `Authorization`, so a preflight) from origin "null" | reaches OpenRouter: 401 for a fake key, body readable |
| | the agent's turn, `run_ts` ×2 | both ran: `sum 10`, `adsBegoneFromThisPage` |
| | store after closing the offscreen document | the session there, 2 runs, the file written |

Each needs the sandbox's own CSP in the manifest
(`content_security_policy.sandbox`: `script-src 'self' 'unsafe-eval' blob:
https://esm.sh; worker-src 'self' blob:`). Under Chrome's default one,
blob workers and esm.sh imports both fail, and so does the kernel.

## What agex-ts would need

- **A classic kernel worker.** The world starts its worker with
  `{ type: "module" }`, which a page with an opaque origin can't do from
  a blob. The spike wrapped `Worker` to drop the type; the bundled
  `worker.js` has no `import`/`export`, so it runs as a classic script.
  In agex-ts this would be a world option (`code.worker.type`), or a
  classic build of the worker.
- Nothing else: `Store.open` takes any `KVStore`, and one that forwards
  each call over `postMessage` (`ParentKV`, `keys`/`items` collected into
  arrays) was enough.

## Costs and open points

- **Size:** the sandbox bundle is 11 MB unminified, 4.1 MB minified,
  1.9 MB gzipped; 3.6 MB of it is the TypeScript compiler that
  `ts-blank-space` brings in to strip types. In the studio it loads as a
  chunk on the first code run; in an extension it's a file on disk, so
  it weighs on the download, not on each page.
- **Store review:** sandboxed pages are MV3's documented place for eval,
  but a sandbox CSP that names a remote origin (esm.sh) and runs code a
  model wrote is a gray area for a listing. The developer download
  isn't reviewed.
- **Every store call is a `postMessage` round trip.** Fine for a turn's
  commits here (the second turn took ~55-230 ms end to end, scripted);
  not measured on a large workspace.
- **Not tried:** a real model turn (needs a key: the provider's request
  path is shown to work), the offscreen document outliving an idle
  service worker for minutes, keys and settings (an options page, or
  handed over from the studio), and reading a tab (the existing
  extension's debugger ops would move in).
