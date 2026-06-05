# Cleanup backlog

Things noticed in passing that are worth revisiting, but out of scope
for the PR that surfaced them. Keep entries short: what, why, rough
size. Delete an entry when it's done.

## Extract the app-preview layer out of `pyodide.js`

`src/lib/pyodide.js` is named (and partly is) the **Pyodide Web Worker
bridge** — `startWorker` / `runPython` / `runPythonStreaming` /
`pyodideStore` / `terminateWorker`. But a pile of **kernel-agnostic
app-preview / iframe-bootloader** helpers accreted into the same file
and are imported by the TS kernel too:

- `buildAppHtml`
- `buildAppStorageShim`
- `preloadPlotly`
- `_rewriteLocalImports`
- `setQueryHandler` / `setLiveIframe`
- the injected iframe-side globals (the `window.spawn` postMessage shim,
  cache-get, app-storage, etc.)

This is why `ts-agent.js` imports `buildAppHtml` from `./pyodide.js`
despite running no Python — pure historical co-location (app preview was
first built alongside the Py kernel). Worth pulling the app-preview
helpers into their own module (e.g. `app-html.js` / `app-bootloader.js`)
so `pyodide.js` is just the Python worker bridge. Medium size, mostly
mechanical move + import updates; touches both kernels' call sites.

Noticed during the sub-tasks → `spawn` migration (the `window.spawn`
global lives in `pyodide.js`).
</content>
