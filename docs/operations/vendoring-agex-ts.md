# Vendoring agex-ts

The studio depends on the agex-ts monorepo (and termish-ts,
kvgit-ts) via committed-in `dist/` artifacts under
`vendor/agex-ts/`. This doc explains why, how to refresh,
and when to remove.

## Why vendor

The agex-ts source repo isn't public yet and isn't published to
npm. The studio's deploy needs the built JS available at
`npm install` time without:

- Cloning a private sibling repo (would need SSH keys / PATs in
  CI secrets).
- Configuring a private npm registry (would need
  GITHUB_TOKEN-flavored auth in CI).
- Bundling everything into a pre-built blob the studio imports
  opaquely (loses tree-shaking, source maps, type info).

Vendoring the built `dist/` directories alongside their minimal
`package.json` files keeps the studio buildable on any vanilla
Node-equipped machine with no auth.

The trade-off: a manual sync step after every agex-ts change
the studio should pick up. Acceptable while agex-ts is private.
When agex-ts ships to npm, the vendor directory goes away.

## What's vendored

Six packages from `../agex-ts/packages/`:

```
vendor/agex-ts/
  agex-ts/             # core agent runtime
  agex-anthropic/      # Anthropic LLM client (peer dep on agex-ts)
  agex-openai/         # OpenAI / OpenRouter LLM client (peer dep on agex-ts)
  agex-runtime-worker/ # Web Worker runtime adapter
  kvgit-ts/            # versioned KV store
  termish-ts/          # shell + fs (kvgit-ts consumer; transitive dep of agex-ts)
```

Each package's `dist/` (built output, ~880 KB total code +
1.4 MB source maps) plus a minimal `package.json` with lifecycle
scripts stripped. Nothing else — no source, no tests, no
configs.

`agex-gemini` and `agex-git` exist in the agex-ts monorepo but
aren't consumed by the studio; they're not vendored.

## How `npm install` resolves it

`package.json` references each vendored package via a `file:`
specifier:

```json
{
  "dependencies": {
    "agex-ts": "file:./vendor/agex-ts/agex-ts",
    "agex-anthropic": "file:./vendor/agex-ts/agex-anthropic",
    "agex-openai": "file:./vendor/agex-ts/agex-openai",
    "agex-runtime-worker": "file:./vendor/agex-ts/agex-runtime-worker",
    "kvgit-ts": "file:./vendor/agex-ts/kvgit-ts",
    "termish-ts": "file:./vendor/agex-ts/termish-ts"
  }
}
```

npm symlinks each into `node_modules/<pkg>` → `vendor/agex-ts/<pkg>`.
Each package's `package.json` has its `exports` map pointing into
`./dist/`, so vite (and any other resolver) finds the built JS
through the standard ESM resolution path.

`termish-ts` is included as a direct studio dep (even though the
studio never directly imports it) because `agex-ts/package.json`
declares it as a runtime dep — without it at the top-level the
resolver can't find it through `agex-ts`'s import chain.

## The sync script

`scripts/sync-agex-ts.sh` copies fresh dist + package.json from
the sibling `../agex-ts/packages/` for each vendored package.
Two non-trivial bits:

### Rewriting `workspace:*`

agex-ts uses pnpm internally; inter-package deps are declared as
`"workspace:*"`. npm doesn't understand workspace-protocol
specifiers, so the sync rewrites each `workspace:*` → `file:../<sibling>`:

```jsonc
// Source agex-ts package.json (pnpm):
"dependencies": {
  "kvgit-ts": "workspace:*",
  "termish-ts": "workspace:*"
}

// Vendored package.json (npm-friendly):
"dependencies": {
  "kvgit-ts": "file:../kvgit-ts",
  "termish-ts": "file:../termish-ts"
}
```

Done in Python in the sync script (`json.load` + walk + `json.dump`)
because portable JSON rewriting in bash is a footgun.

### Stripping scripts + devDependencies

The vendored `package.json` files have `scripts` (build,
prepare, test, etc.) and `devDependencies` dropped. Two
reasons:

- npm runs `prepare` after installing a `file:` dep. With the
  source `prepare` set to `"tsup"`, npm would try to rebuild —
  but we vendored `dist/` only, not `src/`, so tsup has no
  input and explodes.
- The dev deps (vitest, tsup, typescript) aren't needed for
  the studio build; transitively installing them is just
  install-time bloat.

## Sync workflow

```bash
# In ../agex-ts: build, then run tests if you're paranoid
cd ../agex-ts
npm run build
npm test  # optional

# In agex-studio: refresh vendor + verify
cd ../agex-studio
npm run sync-agex-ts
npx vitest run     # studio suite still passes against new vendor
npm run build      # production build succeeds

# Commit
git add vendor/
git commit -m "build: refresh vendored agex-ts (HEAD <hash>)"
git push origin main
```

`npm run sync-agex-ts` doesn't auto-bump `package-lock.json`;
if you add or remove a vendored package (rare), follow with
`rm -rf node_modules package-lock.json && npm install` to
re-resolve.

## .gitignore exception

Root `.gitignore` has `dist/` (the studio's own build output is
gitignored). Without an exception, that rule would also strip
the vendored `dist/`. The .gitignore has:

```
# Re-include the vendored agex-ts dists. The `dist/` rule above
# matches recursively, but vendor/agex-ts/<pkg>/dist holds the
# committed build artifacts the deploy depends on.
!vendor/agex-ts/*/dist/
!vendor/agex-ts/*/dist/**
```

If you ever see a sync that mysteriously commits zero files,
check that the negation is intact.

## Worker bundling caveat

The vendored `agex-runtime-worker/dist/worker.js` has bare
imports (`agex-ts/wrap-fs`, sibling chunks). Vite's default
behavior treats the file as a static asset and copies it
verbatim into `dist/` — the bare imports then 404 in the
browser, producing `"worker failed during boot"` in production
(works in dev because vite's dev server resolves on the fly).

Fix lives in `ts-agent.js`:

```js
import _agexWorkerUrl from "agex-runtime-worker/worker?worker&url";
// ...
const runtime = workerRuntime({ workerUrl: _agexWorkerUrl, ... });
```

The `?worker&url` modifier tells vite to compile the file as a
worker entry point, bundling all imports inline and returning
the hashed asset URL. See commit `536602b`.

This pattern works without any changes to the vendored worker
file itself — vite's worker compiler resolves the bare imports
through the studio's `node_modules` (which contains the symlinks
to `vendor/agex-ts/...`).

## When to remove this

When agex-ts ships to npm publicly:

1. Delete `vendor/agex-ts/`.
2. Delete `scripts/sync-agex-ts.sh`.
3. Remove the `npm run sync-agex-ts` entry from `package.json`'s
   `scripts`.
4. Swap each `file:./vendor/agex-ts/<pkg>` spec for a version
   range (`"^x.y.z"`).
5. Drop the `.gitignore` exception for `vendor/agex-ts/*/dist/**`.
6. Drop the explicit `termish-ts` studio dep if the published
   `agex-ts` no longer references it as `workspace:*` (npm will
   resolve through agex-ts naturally once it's a proper version
   range).

Expected diff: ~150 LOC of cleanup, mostly in `package.json` +
`package-lock.json`. The `?worker&url` import stays — it's a
general vite-worker pattern, not vendoring-specific.

## Storage cost

~2.3 MB committed to the repo (mostly source maps).
`git clone` is still <50 MB. Acceptable.

If repo size becomes a real concern before agex-ts ships,
strip the `.map` files from the sync (`find vendor -name '*.map'
-delete` post-copy). Cost: stack traces from agex-ts code can't
be unminified in browser devtools. Worth it only if storage
genuinely matters.

## Design notes

### Why not git submodule?

Considered, rejected:

- Submodules clone the agex-ts repo (private repo → CI auth
  problem we're trying to avoid).
- Submodule-based workflows tend to leave the submodule out of
  date because pulling main doesn't auto-update submodule
  refs. Cargo-culted re-sync is the same problem we're
  solving here, plus more git ceremony.
- Submodules don't capture the `workspace:*` rewrite step.

### Why not a single bundled blob?

Considered: pre-bundle agex-ts into one IIFE and import it as
an opaque file. Rejected:

- Loses tree-shaking — the studio doesn't use every export.
- Loses type info (no `.d.ts` files unless we bundle those too).
- Doesn't compose with vite's worker compiler — `?worker&url`
  needs the package's `exports` map to find `dist/worker.js`.
- Updates become "rebuild blob + commit blob" which is the same
  manual process as the current vendor approach, with worse
  developer ergonomics.
