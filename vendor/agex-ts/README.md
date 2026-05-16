# Vendored agex-ts

Built JavaScript artifacts from the (currently private) `agex-ts`
repo, copied here so agex-studio is self-contained for deploys.

The studio's `package.json` references these via `file:./vendor/...`
specifiers, so a normal `npm install && npm run build` works on any
machine — no need for a sibling agex-ts checkout, no need for npm
credentials.

## Don't hand-edit these files

Everything under this directory is auto-generated from
`../agex-ts/packages/<pkg>/dist/` by `scripts/sync-agex-ts.sh`.
Edits will be silently overwritten on the next sync.

## Refresh

After making changes in agex-ts:

```bash
(cd ../agex-ts && npm run build)
./scripts/sync-agex-ts.sh
# `npm install` only needed if you've changed which packages exist
```

The sync script copies each package's `dist/` and `package.json`,
rewriting any `workspace:*` references to `file:../<pkg>` so npm
(which doesn't speak pnpm's workspace protocol) can resolve them
within the vendor dir.

## Why vendor instead of npm?

agex-ts isn't published to npm yet. Vendoring the built artifacts
lets the studio ship without depending on a private package
registry or a CI checkout of a private repo. The bytes that user
browsers download are the same bytes that landed in the studio's
commit — reproducible, no opaque fetch-at-build step.

When agex-ts ships to npm, ripping this directory out and
switching the package.json `file:` specifiers to version ranges
is a small PR.
