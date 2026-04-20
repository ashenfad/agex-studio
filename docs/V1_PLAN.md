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
- Phase 4 will later add: `raw.githubusercontent.com`, `*.github.io`, `github.com`, `api.github.com`

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

### Phase 4: BYO-bucket / Shape 3 (URL sharing)

**Recipient-facing URL pattern:** `agex.studio/run/?src=<artifact-url>`. The runtime fetches the bundle from the user-provided URL, rehydrates a fresh local kvgit session, opens the app. Same runtime serves any artifact from any host — agex.studio stays static.

**First storage backend: GitHub via a GitHub App (not classic OAuth App).** Reasons:

- Per-repo scoping (GitHub Apps allow repo-specific permissions; OAuth Apps are account-wide)
- Most users already have GitHub
- Free hosting via `raw.githubusercontent.com` or GitHub Pages
- Inherits authentication, storage, versioning, hosting, discoverability, and "user portfolio" semantics for free

**First-time publish flow:**

1. User clicks "Publish to GitHub" in agex-studio.
2. agex-studio: "You'll need a repo for artifacts." Deep-links to GitHub's new-repo page with a suggested name (e.g., `agex-artifacts`).
3. User creates the repo, returns.
4. "Install the agex-studio App on this repo." Deep-links to the App install page.
5. User installs (App requests `contents: write` + `metadata: read` on the chosen repo only).
6. Returns to agex-studio; ready to publish.

**Subsequent publishes:** confirm slug → publish. The App installation persists.

**Repo layout (multiple artifacts per repo):**

```
my-agex-artifacts/
├── 2026-04-15-sales-dashboard/
│   ├── manifest.json
│   ├── state.bin
│   └── app/
├── 2026-04-16-trip-planner/
│   └── ...
└── README.md   (optional auto-generated index)
```

URL via raw content: `agex.studio/run/?src=raw.githubusercontent.com/<user>/<repo>/main/<slug>/`

URL via Pages (if user enables it on the repo): `agex.studio/run/?src=<user>.github.io/<repo>/<slug>/` — CDN-backed, no per-IP rate limits. Better for viral artifacts.

**Two layers of versioning compose naturally:**

- **Within an artifact**: kvgit + lineage chain (the workshop's history)
- **Across publishes**: actual git on GitHub (the publishing record)

Republishing the same slug overwrites the prior bundle; git history on the repo preserves old versions automatically.

**Credential handling:** apply the principle from architectural decision #3 — the GitHub App installation token lives in a closure inside the publish service, not in agent state. The publish action is a host capability, not something the agent invokes with raw secrets in scope. Generalizable rule: **register the connected client, not the credential**, applies to every credential surface (LLM keys, OAuth tokens, GitHub App tokens, future S3 keys).

**Edge cases:**

- **Public repos required for hosting** — raw needs auth for private repos; GitHub Pages needs Pro. Document clearly in the connect flow.
- **Repo size**: GitHub recommends <5GB; at hobby scale fine. If a user's repo gets huge, they create another.
- **Rate limits**: `raw.githubusercontent.com` has per-IP limits; GitHub Pages doesn't. For artifacts expected to get traffic, recommend Pages.
- **Concurrent publishes from two tabs**: git handles it; one wins. Acceptable.

**Later additions:** S3 / R2 / generic-bucket for users who want artifacts on their own infrastructure. Higher friction (API keys + CORS + bucket policy), smaller audience. Not v1.

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
