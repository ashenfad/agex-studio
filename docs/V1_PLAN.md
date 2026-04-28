# agex-studio v1: Shareable Agent-Built Artifacts

## North Star

agex-studio today is a browser-based AI assistant — a useful demo, but ultimately one of many "chatbot with code execution" tools.

**v1 reframes agex-studio as a runtime for shareable, agent-built Python artifacts.** A user works with an agent in their browser to build something — a dashboard, a visualization, an interactive analysis. When they're done, they publish the *entire entangled session* to a URL: the app, the data, the agent that built it, and the conversation history that shaped it. A recipient opens the URL, interacts with the published thing, and — with their own API key — can fork the workspace and ask the agent to continue or modify the work.

The unique property is the **entanglement**. Other tools optimize for clean separation:

- Notebooks separate code from app
- Dashboards separate data from interface
- Chatbots separate agent from persistent state
- Git separates code from runtime
- Hugging Face Spaces separate apps from the agent that built them

agex-studio's bet is that for a meaningful class of work, **the value of shipping all of these together exceeds the value of being best-in-class at any one of them**.

### The pitch in one sentence

**Asynchronous expertise transfer through delegated tweaking.** You build a working analysis; the agent absorbs your reasoning along the way; the whole environment ships as a URL; the recipient can ask the agent for changes — without you, without setup, without knowing pandas — and gets their own forked artifact when done.

### What the artifact actually is

A **portable lightweight Python container**: the OS (Pyodide + the agex-studio standard library set), the app (whatever the user built in `app/*`), the agent (with full registered policy and primer), and the workspace state (versioned via kvgit, including data files, agent-built helper modules, and shimrs-backed SQL data). All ship together as a single bundle, hosted in the publisher's own bucket, opened in the agex.studio runtime by anyone with the URL.

### What this is NOT for

Being explicit about non-goals sharpens the goal:

- **Not** for high-traffic production apps (Pyodide cold start; single-user model)
- **Not** for real-time multi-user collaboration (single-user-per-tab; kvgit forks rather than shared mutation)
- **Not** for regulated or sensitive data (entanglement means visibility is binary)
- **Not** for cases where "agent has full context" is a liability

### What this IS for

- Shared analyses where the recipient might want follow-up questions
- Internal team tools that benefit from natural-language editability
- Demonstration prototypes that need to actually *run*, not be screenshotted
- Educational artifacts where seeing the construction is part of the value
- One-off useful things that today live in personal repos and never get shared

## Goals (user-facing capabilities)

A **publisher** can:

1. Build an interactive Python app with an agex-studio agent using familiar libraries (pandas, plotly, scipy, etc.).
2. Use shimrs-backed SQL for structured data the agent populates and the app queries.
3. Click "Publish" and see a preview of exactly what's in the bundle, with a clear disclosure of what becomes visible.
4. Choose where the bundle gets hosted (BYO bucket: S3, R2, GitHub-as-storage). The platform stays static; storage is the publisher's.
5. Share the resulting URL anywhere — Twitter, email, Slack — and recipients open it in agex.studio's runtime.

A **recipient** can:

6. Open the URL and load the published app immediately, running entirely client-side via Pyodide.
7. Scroll up through the conversation and reasoning that built the app.
8. See attribution: who published it, what it was forked from (if anything), and a walkable lineage chain.
9. Interact with the app fully, including any Python compute that runs client-side (queries, charts, widgets).
10. Bring their own API key to continue the conversation with the agent, which has full memory of the original session.
11. Have their continuation create a personal mutable fork in their own browser; their writes don't affect the original.
12. Re-publish their fork to a new URL (carrying the lineage chain forward) for further sharing.

## Architectural decisions

### 1. What "the agent" means in the artifact: full reconstituted agent + state

The bundle ships not just the app but the agent's complete working environment: registered policy, primer, event log, REPL namespace, agent-authored helper modules, shimrs SQL data — everything reachable from the current kvgit commit. When the recipient forks, they're stepping into a workshop, not opening a finished file.

### 2. Encoder for bundle contents: keep pickle

Security lives at three real layers:
- **CSP `connect-src` allowlist** for network exfiltration
- **Iframe `sandbox` attribute** for app code blast radius
- **Sandtrap policy gates** for agent-invoked code

The encoder choice is a much weaker layer than these. Pickle stays for both authoring and published bundles.

### 3. Privacy / scrubbing default: ship reachable subgraph + clear disclosure

Stripping arbitrary state risks breaking apps that reference workspace vars; trying to be clever creates false confidence. Instead:

- **Refactor OAuth out of agent state.** Replace `google_token()` (raw string in scope) with pre-connected client objects whose tokens live in closures outside agent reach. Generalizable rule: **register the connected client, not the credential**.
- **Bundle the full reachable kvgit subgraph** by default.
- **Mandatory publish preview** showing the inventory: file count, total size, conversation message count, var count.
- **Prominent disclosure**: "Anyone with this URL can see everything in this bundle. Treat this like 'anyone with the link' Google Doc sharing."
- **Single-checkbox acknowledgment** to force a beat of attention.
- Per-item exclusion controls: deferred to v2.

### 4. Registered modules: hybrid (runtime provides standard set; bundle carries the delta)

Runtime (agex.studio) provides the well-known set: pandas, numpy, plotly, scipy, sklearn, skimage, pypdf, openpyxl, PIL, calgebra, host functions (`search`, `test_app`, `live_app`, `render_pdf`, etc.), the `Response` class.

Bundle carries:
- Serialized **policy declaration** (which standard-set members are registered, with what visibility/include/exclude options)
- The agent's **primer**
- Publisher-added **skills** as text content
- **VFS contents** (naturally includes any agent-authored helper modules; travel as kvgit blobs, import-resolve via agex's existing VFS-imports feature)
- A **runtime-version manifest entry** (no enforcement in v1, but recording is free at publish time and irreversible if skipped)

Preserves the strategic Pyodide amortization win that makes hosted-runtime distribution work.

### 5. Replay vs. live chat UI: unified

No special "this is history" mode. Conversation continues — when the recipient sends a message, it's the next message in the stream. Agent doesn't know it's been cloned (no actionable use; only introduces destabilizing self-referential noise). Recipient awareness comes from the UI lineage breadcrumb, not from the agent's internal model.

### 6. Lineage / attribution chain

Each published artifact's manifest carries a `lineage` section:

```json
{
  "author": "alice@gh" | "anonymous",
  "parent": {
    "url": "https://...",
    "content_hash": "sha256:...",
    "forked_at_commit": "abc123",
    "parent_summary": {
      "author": "yoshi@gh",
      "title": "Q3 Sales Dashboard",
      "published_at": "2026-04-15"
    }
  }
}
```

- **Visual fork-point dividers** in the chat are computed by the renderer from `forked_at_commit`. Zero changes to agex's event types.
- **Lineage breadcrumb** at the top of the chat: "Forked from yoshi@gh's *Q3 Sales Dashboard*." Walks back as far as the chain reaches.
- **`parent_summary` solves the broken-parent problem**: attribution preserved even if the parent URL 404s.
- **Default carries the chain forward**; opt-out requires deliberate action.
- **Verifiability via content-addressing**: kvgit makes `forked_at_commit` a stable identifier; a fork's authenticity can be checked by verifying its bundle contains the parent's commit.

## Decisions deliberately deferred

- **"Clear agent state" toggle.** v1 is always continue. If a recipient wants a fresh-perspective agent they can prompt for it ("ignore the prior conversation"). Add a UI toggle only if practice shows that's insufficient.
- **Per-item exclusion in publish preview.** v1 ships everything reachable; v2 may add granular drop controls.
- **Versioned runtimes for back-compat.** v1 records runtime version but doesn't enforce. v2 may pin runtimes to artifact versions if the ecosystem grows enough to warrant.
- **Multi-artifact session GC.** Recipients accumulate forks in IndexedDB over time; v2 may add cleanup.
- **Discoverability / public gallery.** v1 is "share via URL." No platform-side discovery. v2 if there's a community to discover.
- **First-run loading UX polish.** Real but not strategic; handle when building.

## Sequenced work plan

Each phase ships something usable; partial completion leaves the project ahead.

### Phase 0: hardening (independently valuable; ship first)

Two independent tracks — can run in parallel.

**Track A: CSP allowlist via meta tag in `index.html`.** Allowlist:

- Current providers: Pyodide CDN (`cdn.jsdelivr.net`), PyPI (`pypi.org`, `files.pythonhosted.org`), OpenRouter, Anthropic, Google APIs (`*.googleapis.com`, `*.googleusercontent.com`, `accounts.google.com`, `*.google.com`, `apis.google.com`), Plotly CDN (`cdn.plot.ly`), Cloudflare CDN (`cdnjs.cloudflare.com`), esm.sh (for interactive-app iframe imports)
- **Local LLM endpoints**: `http://localhost:*`, `http://127.0.0.1:*` (enables Ollama, LM Studio, llama.cpp server, vLLM, LocalAI via the existing `base_url` setting). Browsers carve out HTTPS→loopback HTTP via "potentially trustworthy origins" — works in Chrome/Edge/Firefox without flags; worth noting Safari can be stricter. IPv6 `[::1]` not included — CSP spec rejects the bracket notation; `localhost` covers the common case.
- Concessions accepted: `'unsafe-eval'` + `'wasm-unsafe-eval'` (Pyodide requirement), `'unsafe-inline'` in `script-src` (Google Sign-In), `data:` in `script-src` (app preview serves agent-authored modules as data URIs). The real defense lives in `connect-src` allowlist + iframe origin isolation (Phase 2); script-src additions don't open new attack classes.
- `img-src` intentionally broad (`https:`) so agent-built apps can load images from arbitrary sources (e.g., Pokémon-style fan apps). The broader image allowance would open an exfil side channel, but once Phase 2 (iframe origin isolation) lands, the iframe has no secrets to exfil anyway.
- Phase 4 will later add: `gist.githubusercontent.com` (raw gist content for artifact fetch), `api.github.com` (gist API for publishing). The repo-route escalation (raw.githubusercontent.com, *.github.io, github.com) only enters the picture if/when we layer it on as a v2 option for users who outgrow gist size limits.

Iterative tightening via DevTools console; meta-tag form can't report violations to a URL, so watch the console for `Refused to connect to ...`.

**Track B: OAuth refactor** — replace `google_token()` with pre-connected calendar client; token lives in closure outside agent reach. Apply the same pattern to `GoogleDriveFS` if not already (it already accepts a callable). Remove `_agent.fn(google_token, ...)` registration entirely. Update `gcal.md` skill + chat primer to reflect new `calendar.list_events(...)` pattern. No back-compat shim — existing sessions break cleanly.

Both tracks ship value independently of the rest of v1.

### Phase 1: shimrs integration

- Register shimrs in `initAgent()` so the agent has SQL alongside files.
- Add primer section and a `/skills/shimrs.md` skill file.
- Validates the agent-uses-SQL ergonomics with real sessions before any artifact work.

### Phase 2: iframe origin isolation (prerequisite for stranger-authored artifacts)

Detailed plan: [PHASE_2_PLAN.md](PHASE_2_PLAN.md). Summary below.

The app preview iframe currently uses `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` defeats the isolation: the iframe gets agex.studio's origin and can read parent's `localStorage`, OAuth tokens, and IndexedDB. For the current PoC (user's own tab, user's own agent) this is acceptable. **For Phase 4+ where strangers open stranger-authored artifacts, it's not.**

The fix is to remove `allow-same-origin`, but that breaks `test_app` / `live_app`:

- `executeActions()` in `pyodide.js` manipulates the iframe via `iframe.contentDocument` (clicks, typing, reads, screenshots). With an opaque origin, `contentDocument` returns `null`.
- `collectResults()` similarly depends on direct DOM access.

**Work required:**

- Add an in-iframe message handler (injected by `buildAppHtml`) that listens for action commands (`click`, `type`, `select`, `read`, `eval`, `screenshot`) and executes them on the iframe's own DOM, posting results back.
- Replace every `iframe.contentDocument.*` call in `executeActions`/`collectResults` with a postMessage round-trip.
- Verify parent's existing message handlers tolerate `event.origin === 'null'` (opaque iframes); loosen any tight origin checks.
- Remove `allow-same-origin` from the preview iframe's sandbox attribute. Preview iframe now has opaque origin; cannot read parent state.
- Same treatment for the hidden test-app iframe in `pyodide.js:runTestApp`.

Estimated a few days of focused work. Not trivial, but bounded — all action types are a small, known set.

**Value independent of artifact work:** protects today's users from any agent-built app that turns out malicious; closes the `img-src` exfil side channel for the iframe context.

### Phase 3: bundle export (local-only first)

- Implement subgraph extraction from kvgit (walk reachable from current commit; include only kvgit content + manifest).
- Build bundle format: manifest (with lineage `parent: null` for first-publish) + serialized state + runtime-version field.
- "Export to file" UI: downloads `.agex-artifact` (or zip).
- Corresponding "Open from file" path on recipient side.
- Validates the entire entanglement-and-rehydration cycle with no hosting story.

### Phase 4: gist publishing / Shape 3 (URL sharing)

Detailed plan: [PHASE_4_PLAN.md](PHASE_4_PLAN.md). Summary below.

Phase 4 has two interlocking halves:

1. **Security hardening for stranger-facing deployment** (because Phase 4 starts shipping artifacts to recipients the publisher doesn't personally know)
2. **Publishing mechanics** (GitHub App integration, URL pattern, repo layout)

The security half has been deliberated extensively; the landed approach keeps agex-studio's single-origin simplicity and the agent-app entanglement thesis intact:

- **LLM bridge via adapter seam in agex.** Add an optional `fetch_adapter` parameter to `pyfetch_openai` / `pyfetch_anthropic` clients in agex. agex-studio passes a `JsBridgeAdapter` that routes network calls through main-thread JS, where the OpenRouter key lives in `localStorage` and never enters Python scope. Applies to all sessions, not just external — general defense.
- **External session concept.** Sessions opened via `agex.studio/run/?src=...` carry an `external: true` flag. Persistent for the session lifetime.
- **Google OAuth auto-disconnect for external sessions.** No Drive mount, no `_google_access_token` wired up. Drive features unavailable when opening external artifacts.
- **Disclosure splash** on first external-artifact open: informs the visitor that the artifact can read (but not exfiltrate to arbitrary origins) data from their other sessions; suggests a private window for full isolation.
- **Keep `img-src` permissive** (preserve the Pokémon-style external-image case). The exfil channel this theoretically opens is slow, GET-based, bandwidth-limited, and — after the LLM bridge — targets only unstructured IndexedDB contents with no clear monetization path. Disclosure handles the residual.
- **No domain split.** Rejected earlier because it fractures the workspace UX and defeats the entanglement thesis that makes agex-studio distinctive.

Post-LLM-bridge threat surface: a malicious pickle in a published artifact cannot steal the visitor's OpenRouter key, Google OAuth, or other credentials (none are in Python scope). It can potentially read other sessions' IndexedDB contents but cannot exfiltrate at speed; visitors concerned about this open in a private window. This is the "hobby-scale with honest disclosure" posture.

**LLM bridge is independently valuable** and can ship before the rest of Phase 4 as standalone hardening. The remaining items (external session, auto-disconnect, disclosure) are only meaningful once URL-opened artifacts exist.

**Publishing mechanics (gist-first):**

**Recipient-facing URL pattern:** `agex.studio/run/?src=<artifact-url>`. The runtime fetches the bundle from the user-provided URL, rehydrates a fresh local kvgit session, opens the app. Same runtime serves any artifact from any host — agex.studio stays static.

**First storage backend: GitHub Gists (not a GitHub App on a repo).** Reasons:

- **Smallest possible scope.** A `gist`-only token is the minimum scope GitHub offers. Smaller than the per-repo `contents: write` + `metadata: read` permissions a GitHub App would need on a chosen repo. User cannot accidentally grant access to private repos.
- **Static-friendly auth.** No OAuth callback, no `client_secret`, no backend. PAT-based: user creates a Personal Access Token with `gist` scope (deep-linked from the studio's Settings panel), pastes it in, studio uses it as a Bearer token on the gist API. Same posture as the existing OpenRouter / Anthropic / Google API key BYO flow.
- **Zero setup beyond auth.** No repo to create, no App to install. After the PAT lands in Settings, every publish is one click.
- **Hosting is automatic.** Gists are served from `gist.githubusercontent.com` (raw) — no rate-limit concerns at hobby scale.
- **Versioning is inherent.** Gists are real git repos. Republish-same-id rewrites the gist content; commit history is preserved by GitHub. The "two layers of versioning" framing still applies (kvgit lineage within an artifact, gist commit history across publishes).
- **Discoverability for free.** Visible on the user's gist profile — the same "user portfolio" semantic the original GitHub-App / dedicated-repo plan got.

**Why not OAuth flow.** Traditional GitHub OAuth requires a `client_secret` for token exchange that a static SPA can't safely hold (a public bundle leaks it). GitHub does not support PKCE on OAuth Apps (longstanding gap; the standard SPA escape hatch isn't available). The viable workarounds — backend proxy, device flow — either fight the "no server" thesis or add steps. PAT sidesteps both: the user grants exactly the scope they want, with no app registration on the studio side at all.

**First-time publish flow:**

1. User clicks "Publish" in agex-studio.
2. If no GitHub PAT is in Settings, the publish dialog shows a "Connect GitHub" panel with a deep-linked button to GitHub's PAT creation page (classic: `https://github.com/settings/tokens/new?description=agex-studio&scopes=gist`; fine-grained: GitHub doesn't accept prefilled scopes here, so the studio shows a "select 'Gists: read and write'" hint instead). User clicks, creates the token, copies it, pastes it in Settings.
3. Returns to publish: inventory + disclosure copy + acknowledgment checkbox + "Publish" button.
4. On click: studio bundles the artifact, POSTs to `https://api.github.com/gists` with the PAT as a Bearer Authorization header. Response carries the gist `id` and `html_url`; studio constructs the runtime URL from the raw content base.
5. Modal flips to the published state — the runtime URL with a Copy button.

**Subsequent publishes:** just steps 3-5 (token persists in localStorage between sessions).

**Bundle layout in the gist:**

Gists don't support directory structure — files are flat. The bundle flattens accordingly and re-inflates on the recipient side:

```
manifest.json
state.bin.b64                 (base64-encoded; recipient decodes before unpickling)
app__index_html
app__main_js
app__styles_css
helpers__utils_py
...
```

The `app__` and `helpers__` prefixes round-trip back to `app/index.html`, `helpers/utils.py`, etc. when the recipient runtime reads the gist. Manifest carries the file inventory so the recipient knows what to reconstitute.

**URL UX (post-publish):**

The publish dialog has three visible states:

1. **Pre-publish**: inventory listing (file count, projected bundle size, conversation message count, var count) + disclosure copy ("Anyone with this link can see everything in this bundle. Treat this like 'anyone with the link' Google Doc sharing.") + acknowledgment checkbox + "Publish" button.
2. **Publishing**: spinner + "Uploading to GitHub…", button disabled to prevent double-submit.
3. **Published**: the runtime URL ready to share.

```
✓ Published as a secret gist

Anyone with this link can open the artifact:

  ┌──────────────────────────────────────┬─────────┐
  │ https://agex.studio/run/?src=…       │  Copy   │
  └──────────────────────────────────────┴─────────┘

Lineage:    Forked from yoshi@gh's "Q3 Sales Dashboard"
GitHub:     gist.github.com/<user>/<id>  ↗

                                        [ Close ]
```

The URL input is read-only and pre-selected on focus (click anywhere → all selected; no triple-click required). The Copy button briefly flashes "Copied!" for ~2s on click. "View on GitHub" links to the bare gist URL for inspection / rename / delete by the publisher. Error states (401 invalid token, 422 too-large gist, network 5xx) surface inline with actionable messages: "Your GitHub token isn't valid. Update it in Settings.", "This artifact is X MB; gists work best under ~10 MB.", etc.

**Two layers of versioning compose naturally:**

- **Within an artifact**: kvgit + lineage chain (the workshop's history).
- **Across publishes**: gist commit history (the publishing record).

Republish overwrites the gist's contents; gist git history preserves prior versions automatically. (Same shape as the original repo plan, just at gist granularity.)

**Credential handling:** the GitHub PAT lives in `localStorage`, never in Python scope. Publish is a host capability invoked from main-thread JS — same posture as the LLM bridge for OpenRouter / Anthropic keys, and the same generalizable rule: **register the connected client, not the credential.**

**Edge cases:**

- **Size ceiling.** Gists soft-limit at ~1MB per file before GitHub's web UI gets unhappy and ~10MB total in practice. agex bundles whose `state.bin` is multi-MB (sessions over real datasets, sessions with embedded Plotly figures or PIL images) may exceed this. The publish-preview's projected bundle size is the pre-flight signal; the disclosure copy explicitly names the limit so users can prune before committing.
- **Public vs secret.** Default to **secret** (URL-only access). A toggle in the publish dialog can promote to public for users who want the gist visible on their gist profile.
- **Token revocation.** User can revoke the PAT any time from GitHub Settings; subsequent publishes will 401. Studio surfaces this with a "Reconnect GitHub" path back to the PAT creation deep link.
- **Anonymous publishing isn't a fallback.** GitHub disabled anonymous gist creation in March 2018 (spam). Recipients still browse anonymously, but every publisher needs an account. Same constraint a repo-based publish flow would have, so this isn't a regression — just worth knowing the "publish without an account" v2 escalation path doesn't exist for gists.
- **Concurrent publishes from two tabs**: gist API is last-write-wins; one tab's response overwrites the other's. Acceptable at hobby scale.

**Later additions (deferred to v2+):**

- **Repo-based publishing** for users who hit the gist size ceiling or want the multi-artifact-per-repo portfolio shape. Returns to the original GitHub App design as an opt-in escalation rather than the default — gist-first because most artifacts fit, repo-based for the ones that don't.
- **BYO bucket** (S3 / R2 / generic) for users who want artifacts on their own infrastructure. Higher friction (API keys + CORS + bucket policy), smaller audience.
- **"My published artifacts" view** that lists session-published gists for the current PAT, with rename / delete actions.

### Phase 5: lineage UI

- Lineage breadcrumb at top of chat.
- Fork-point dividers in chat log (computed from `forked_at_commit`).
- "View parent" link.
- Re-publish action that carries lineage forward.

### Phase 6: publish preview polish

- Inventory listing in publish dialog.
- Disclosure copy + acknowledgment checkbox.
- File-size / message-count / var-count summary.
- Heuristic flags for items that look sensitive (column names suggesting PII, large uploads, etc.) — informational, not blocking.

Phases 2–3 are the hardest technical work (iframe origin refactor + kvgit subgraph bundling). Phases 4–6 are increments on top. Phases 0 and 1 ship standalone value; 0 should ship first regardless of whether the rest happens.

**Why Phase 2 sits where it does:** iframe origin isolation must exist before Phase 4 ships artifacts from strangers to strangers. Sequencing it after shimrs (Phase 1) means the SQL data layer is available inside the refactored iframe from day one. Sequencing it before bundle export (Phase 3) means we don't have to retrofit isolation onto the artifact format after the fact.

## Why agex-studio (not agex-ts)

Brief note for future explainers:

This v1 doubles down on Python rather than building agex-ts because:

1. **Shimrs + kvgit + sandtrap + the data stack is the moat.** Browser-native, full Python compute, agent-built shareable artifacts is a combination no JS framework can credibly match.
2. **agex-studio works today.** Months of agex-ts foundation work before any user-facing capability vs. weeks of additive work on a working substrate.
3. **The bridge friction that originally motivated considering agex-ts mostly hits the games/creative-coding niche**, which is a different product. For agex-studio's actual workload (data analysis, dashboards, interactive tools), Python is the right runtime.
4. **The Pyodide cold-load tax amortizes in the platform's favor** for Shape 3: visitors pay it once across all artifacts they ever view on agex.studio.

agex-ts remains a valid future direction for a *different* product targeting the JS-native niche. Not now.
