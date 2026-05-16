#!/usr/bin/env bash
#
# sync-agex-ts.sh — refresh the vendored copy of agex-ts in
# `vendor/agex-ts/` from the sibling `../agex-ts` repo.
#
# The studio embeds agex-ts's built `dist/` for each consumed
# package so deploys don't need access to the agex-ts repo (which
# isn't public yet). Run this after every agex-ts rebuild that the
# studio should pick up:
#
#     (cd ../agex-ts && npm run build)
#     ./scripts/sync-agex-ts.sh
#     npm install   # only needed if you've nuked node_modules
#
# What this does for each consumed package:
#   - rm -rf vendor/agex-ts/<pkg>/{dist,package.json}
#   - cp -R ../agex-ts/packages/<pkg>/dist into the vendor slot
#   - cp ../agex-ts/packages/<pkg>/package.json into the vendor slot
#   - rewrite `workspace:*` references in deps / peerDeps to
#     `file:../<pkg>` so npm (which doesn't speak pnpm's workspace
#     protocol) can resolve them via the sibling vendored copies.
#
# The vendored dist files are committed to git. The bytes that ship
# to user browsers are the same bytes that landed in this commit —
# no opaque "fetched at build time" step.
set -euo pipefail

# Resolve paths relative to the script location so the command
# works regardless of where it's invoked from.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
STUDIO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
AGEX_TS_ROOT="$( cd "$STUDIO_ROOT/../agex-ts" && pwd )"
VENDOR_DIR="$STUDIO_ROOT/vendor/agex-ts"

if [ ! -d "$AGEX_TS_ROOT/packages" ]; then
    echo "error: sibling agex-ts repo not found at $AGEX_TS_ROOT" >&2
    exit 1
fi

# Packages the studio (transitively) imports. termish-ts isn't
# directly imported by the studio but is a runtime dep of agex-ts,
# so it has to be vendored too.
PACKAGES=(
    agex-ts
    agex-anthropic
    agex-openai
    agex-runtime-worker
    kvgit-ts
    termish-ts
)

mkdir -p "$VENDOR_DIR"

for pkg in "${PACKAGES[@]}"; do
    src="$AGEX_TS_ROOT/packages/$pkg"
    dst="$VENDOR_DIR/$pkg"
    if [ ! -d "$src/dist" ]; then
        echo "error: $src/dist missing — run 'npm run build' in agex-ts first" >&2
        exit 1
    fi
    echo "→ syncing $pkg"
    mkdir -p "$dst"
    rm -rf "$dst/dist" "$dst/package.json"
    cp -R "$src/dist" "$dst/dist"
    # Rewrite `workspace:*` → `file:../<sibling>` so npm can resolve
    # inter-package deps within the vendor dir without pnpm's
    # workspace protocol. Done in Python because portable JSON
    # rewriting in bash is a footgun.
    python3 - "$src/package.json" "$dst/package.json" <<'PY'
import json
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    pkg = json.load(f)

def rewrite(deps):
    if not deps:
        return
    for name, spec in list(deps.items()):
        if isinstance(spec, str) and spec.startswith("workspace:"):
            # All workspace deps map to sibling vendored packages.
            deps[name] = f"file:../{name}"

rewrite(pkg.get("dependencies"))
rewrite(pkg.get("peerDependencies"))
rewrite(pkg.get("devDependencies"))

# Strip lifecycle scripts (`prepare`, `build`, etc.) — npm runs
# `prepare` after installing a `file:` dep, which would try to
# rebuild from src/ that we didn't vendor. We're shipping the
# already-built dist; there's nothing for npm to do.
pkg.pop("scripts", None)
# devDependencies are only needed during a build that we're
# explicitly skipping. Drop them so npm doesn't try to install
# vitest / tsup / etc. transitively under each vendored package.
pkg.pop("devDependencies", None)

with open(dst_path, "w") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
PY
done

echo "✓ sync complete — $(date)"
echo "  Run 'npm install' if you've changed which packages are vendored."
