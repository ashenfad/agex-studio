# Phase 4 Plan: BYO-bucket URL Sharing + Security Hardening

**Status:** planned, not started
**Depends on:** Phase 0 (complete), Phase 2 (complete), Phase 3 (bundle export)
**Security writeup precedes implementation** — the threat model and agreed approach are documented here before code changes begin.
**See also:** [V1_PLAN.md](V1_PLAN.md) for overall sequencing

## Problem statement

Phase 4 ships *URL sharing* for published artifacts. When recipients opening a URL are strangers the publisher doesn't personally know, we cross from "trusted-circle sharing" (Phase 3's file-download model) into "stranger-to-stranger sharing." That introduces real threat-model concerns that Phase 4 needs to address — not by fracturing the product, but by a focused set of small hardening changes plus honest disclosure.

This plan covers both halves: the security prep *and* the publishing mechanics.

## Threat model (landed after extensive deliberation)

### What we defend

When a visitor opens a published artifact at `agex.studio/run/?src=<url>`:

- **Credentials never enter Python scope** (LLM bridge) — malicious pickle can't steal API keys
- **Google OAuth not wired up** for external sessions — can't steal Google credentials because there are none in that context
- **CSP `connect-src` allowlist** blocks fast exfil via fetch/XHR/WebSocket to arbitrary origins

### What we disclose (accept)

- A malicious pickle CAN read the visitor's other agex-studio sessions from IndexedDB (browser storage is per-origin; same-origin IndexedDB isolation within a single origin is structurally impossible without domain-splitting)
- It can theoretically exfiltrate that data via `img-src` GET requests (slow, bandwidth-limited, suspicious in Network tab)
- Visitors are informed via a disclosure splash on first external-artifact open
- Visitors seeking full isolation can open the artifact in a private browsing window (fresh IndexedDB)

### What we explicitly chose against

**Domain split** (`preview.agex.studio` vs `agex.studio`) — rejected because it:
- Fractures the user workspace ("forks of external things live somewhere else")
- Defeats the entanglement thesis (artifact = agent + app + state in one workspace)
- Requires migrating off GitHub Pages or running two deployments
- Solves a theoretical attack (IndexedDB grab-bag exfil) at disproportionate product cost

**Per-artifact runtime isolation in a sandboxed iframe** — rejected because it:
- Costs per-artifact Pyodide cold start (degrades Shape 3 amortization)
- Requires an inter-frame coordination protocol
- Is architectural surgery for a threat the LLM bridge already addresses structurally

The calibration: defend what's concrete and valuable (credentials); disclose what's theoretical (IndexedDB mining at scale); trust users to make the final call for their own context. This matches hobby-scale product economics.

## Security hardening (Half 1)

### 1. LLM bridge via adapter seam in agex

**Goal:** OpenRouter / Anthropic API key lives only in JS's localStorage, never in Python scope. A malicious pickle running in the Pyodide worker has nothing to steal.

**Agex-side change (publishable independently):**

Add an optional `fetch_adapter` parameter to `pyfetch_openai` and `pyfetch_anthropic` clients. Default behavior unchanged.

```python
class FetchAdapter(Protocol):
    async def fetch(self, url, *, method, headers, body) -> Response: ...
    async def fetch_stream(self, url, *, method, headers, body) -> AsyncIterator[bytes]: ...

class PyfetchOpenAI:
    def __init__(self, ..., fetch_adapter: FetchAdapter | None = None):
        self._adapter = fetch_adapter or _DefaultPyfetchAdapter()
```

Internal callsites change from `await pyfetch(...)` to `await self._adapter.fetch(...)`.

When `fetch_adapter` is provided, the client constructs headers *without* `Authorization` — the adapter injects auth on the JS side. `api_key` parameter becomes optional (None acceptable, skip Authorization header).

Both clients get the seam; shared tests cover the adapter contract.

**agex-studio-side change:**

`JsBridgeAdapter` class (or module). Its `fetch` and `fetch_stream` methods postMessage to main-thread JS, which:

1. Reads the OpenRouter key from localStorage
2. Adds `Authorization: Bearer <key>` to outgoing headers
3. Does real `fetch`
4. For non-streaming: returns the response JSON
5. For streaming: uses `response.body.getReader()`, postMessages each chunk back with a stream ID until done

Python side maintains per-stream-id async iterators that resolve chunks in arrival order.

**`initAgent` change:** stop passing `api_key` to `connect_llm`. Instantiate a `JsBridgeAdapter` and pass it as `fetch_adapter`. The key never enters the worker's Python scope.

**Tests:**
- agex side: adapter contract tests (both providers) against a mock adapter that returns canned responses
- agex-studio side: end-to-end with a mock JS fetch that echoes back
- Manual verification: confirm `_OR_API_KEY` no longer exists in the Pyodide worker after init

### 2. External session concept

Sessions opened via `agex.studio/run/?src=<url>` carry an `external: true` flag in their kvgit metadata and/or a sidecar session-config store.

- URL entry point detection: `agex.studio/run/?src=<url>` → runtime checks URL at app load, creates a new session with `external: true` and seeds it from the fetched bundle
- Flag persists for the lifetime of the session in IndexedDB
- Visible to the user via a subtle UI marker (e.g., "External session" badge in the session drawer)
- Cannot be unset — once external, always external. To escape, the user creates a new non-external session.

Implementation: small addition to `sessions.js` for the flag; `agent.js` reads it at initAgent time and conditionally disables Drive-related setup.

### 3. Google OAuth auto-disconnect for external sessions

When `external === true`:
- Skip the Drive FS mount in `initAgent` (the `_patched_get_fs_backend` block doesn't apply)
- Skip setting `_google_access_token` from worker messages (or set it to None unconditionally)
- Any Google-related skills (calgebra gcal if it comes back later) not registered
- UI indicates "Drive unavailable in external session" in the Drive panel

Visitors' *other* (non-external) sessions are unaffected. Their authoring workflow retains full Drive support.

### 4. Disclosure splash

On first external-artifact open in a browser (per-origin, not per-session), show a dismissible modal:

```
Opening an external artifact

This artifact's code will run in your browser.
For your safety:
- Your OpenRouter API key stays in this browser and is NOT accessible to the artifact
- Google Drive is disconnected for external artifacts
- The artifact can read data from your other agex-studio sessions in this browser
  but cannot send that data to arbitrary sites

For full isolation, open this URL in a private browsing window.

[ ] Don't show this again
[Continue]  [Cancel]
```

Store dismissal state in `localStorage` under a key like `agex-external-disclosure-acked`. If a visitor clears browser data or uses a new browser, they see it again. Cancel returns them to the author home.

### 5. CSP adjustments

None needed. Current CSP is correct for this approach:
- `connect-src` allowlist remains tight (blocks fetch exfil to arbitrary origins)
- `img-src https:` remains permissive (Pokémon case preserved; exfil channel documented but accepted)
- `frame-src` remains narrow
- All Phase 0 allowlists stay in place

Phase 4 adds to `connect-src`: `raw.githubusercontent.com`, `*.github.io`, `github.com`, `api.github.com` for the GitHub App flows.

## Publishing mechanics (Half 2)

(This section summarizes the GitHub-App-based publish flow already detailed in V1_PLAN.md's Phase 4 section; repeated here for document completeness.)

### Recipient URL pattern

`agex.studio/run/?src=<artifact-url>`. The runtime fetches the bundle, hydrates a fresh external session, opens the app. Same runtime serves any artifact from any host. agex.studio stays static.

### First-time publish flow (GitHub App)

1. User clicks "Publish to GitHub"
2. agex-studio deep-links to GitHub's new-repo page with suggested name
3. User creates the repo, returns
4. Deep-link to GitHub App install page (scoped to chosen repo)
5. User installs — App requests `contents: write` + `metadata: read` on the single repo
6. Ready to publish

Subsequent publishes: confirm slug → publish (installation persists).

### Repo layout

Multiple artifacts per repo as directories (`slug/manifest.json`, `slug/state.bin`, `slug/app/*`). URL via raw content (`raw.githubusercontent.com/...`) or Pages if user enables it.

### Versioning

- Within an artifact: kvgit + lineage chain
- Across publishes: GitHub's git history on the repo

### Credential handling

GitHub App installation token lives in a closure inside the publish service on the main thread, not in agent state. Same principle as LLM bridge: register the connected client, not the credential.

## Test strategy

### Unit tests (agex side)

- `FetchAdapter` contract tests (non-streaming and streaming cases) for both OpenAI and Anthropic clients
- Mock adapters verify the client constructs correct requests without auth headers when adapter is used
- Streaming adapter tests verify chunk-ordering and cancellation propagation

### Unit tests (agex-studio side)

- `JsBridgeAdapter` tests with a mock JS fetch (happy-dom)
- Verify correct message shape: `{type: 'agex-llm-request', streamId, url, method, headers, body}`
- Verify non-streaming resolution, streaming chunk iteration, and error propagation

### Integration tests

- End-to-end flow: `JsBridgeAdapter` + bridge handler + mock fetch → verify Python receives the mocked response faithfully
- External session detection: URL with `?src=` creates a session with `external: true`; Drive mount skipped
- Disclosure modal: fires once per origin, respects dismissal

### Manual verification

- Open a real artifact URL in a browser
- Inspect Pyodide worker globals: confirm no `_OR_API_KEY`, no `_google_access_token`
- Send a chat message: confirm it routes through the JS bridge (network tab shows fetch from main thread, not from worker)
- Attempt a Drive operation: fails cleanly with "Drive not available in external session"
- Disclosure appears on first external artifact, not on subsequent ones
- Opening an artifact in a private window: fresh IndexedDB, no cross-session access

## Commit plan

### Commit 1: `feat(agex/llm): add fetch_adapter seam to pyfetch clients`

- Publishable independently in agex
- Changes to `pyfetch_openai.py`, `pyfetch_anthropic.py`
- `FetchAdapter` protocol defined
- Default behavior unchanged
- Tests for adapter contract on both providers
- New agex version published

### Commit 2: `feat(preview): JsBridgeAdapter for LLM calls`

- In agex-studio: new `JsBridgeAdapter` class, wired into `initAgent`
- JS bridge handler in `pyodide.js` (or `worker.js`) for `agex-llm-request` messages
- OpenRouter key read from localStorage on each request (rotation-safe)
- Streaming protocol with per-stream-id chunk delivery
- Tests with mock JS fetch
- LLM bridge active for *all* sessions (not just external) — general hardening

### Commit 3: `feat(sessions): external session flag and entry point`

- `agex.studio/run/?src=<url>` URL route
- On first load: fetch bundle, create new session with `external: true`, hydrate state
- Session drawer shows "External" badge
- `external` flag readable from `agent.js` at initAgent time

### Commit 4: `feat(sessions): disable Drive for external sessions`

- `initAgent` conditionally skips Drive mount when `external === true`
- Google token never set in external sessions
- Drive panel in UI indicates "not available in external session"

### Commit 5: `feat(preview): disclosure splash on first external-artifact open`

- Modal with disclosure copy + "don't show again" checkbox
- Once-per-origin state in localStorage
- Cancel action returns to author home

### Commit 6: `feat(publish): GitHub App integration for URL publishing`

- Publish button in agex-studio
- Deep-links to GitHub new-repo + app-install flows
- Bundle upload to user's repo via GitHub App API
- Return shareable URL to user
- Tests for publish mechanics (mockable GitHub API)

Commits 1 and 2 can ship before 3-5 (LLM bridge is independently valuable). Commits 3-5 should land together (external session concept + its protections + its disclosure). Commit 6 is the Phase 4 user-facing feature that depends on the others.

## Effort estimate

- **Commit 1** (agex adapter seam): ~4 hours including tests. +~2 hours for streaming.
- **Commit 2** (JS bridge + streaming): ~6 hours. Streaming protocol is the bulk.
- **Commit 3** (external session concept): ~3 hours
- **Commit 4** (Drive disabled for external): ~2 hours
- **Commit 5** (disclosure splash): ~2 hours
- **Commit 6** (GitHub publishing): ~8 hours including install-flow UX
- **Testing and polish**: +4-6 hours total

**Total: 4-6 days of focused work.** Streaming is the most likely place to burn time; GitHub App integration is the second.

## Rough edges to anticipate

1. **Streaming robustness**: SSE parsing, cancellation, back-pressure, partial tokens, network errors mid-stream. Budget a full day for making streaming solid.
2. **OpenRouter key rotation**: JS side must read from localStorage per-request (not cache) to pick up key changes.
3. **Error propagation through adapter layers**: LLM → adapter → JS fetch → JS error → postMessage → Python exception → agex loop → UI. End-to-end test with intentionally bad inputs (invalid key, 429, network drop, malformed SSE).
4. **Disclosure wording iteration**: First draft will feel too scary or too casual. Budget time for 2-3 iterations.
5. **External session discoverability**: users may be confused why Drive is disabled. Clear UI indication is important.
6. **agex version management**: Commit 1 requires an agex release to PyPI + update the pinned version in `worker.js`. Coordinate release.
7. **GitHub App setup**: creating the App itself is a one-time config (manifest, install URLs, webhook endpoints). Budget time for getting this right.

## Post-phase followup (v2+)

- **Tighten `img-src`** if abuse becomes a real concern
- **Per-artifact runtime isolation** if product grows beyond hobby scale
- **Alternative storage backends** (S3, R2, generic) for users who want artifacts on their own infrastructure
- **Publish approval workflow** if teams start using agex-studio for internal-tool sharing
