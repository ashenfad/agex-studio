# Agex Studio: implementation docs

How the studio is put together, for someone (a person or an agent)
about to change a piece of it and wanting the context the code doesn't
carry. For what the studio is and how to use it, see the
[project README](../README.md); the in-app docs are under
[public/docs/](../public/docs/).

The studio was rebuilt on agex-ts's world and loop;
[roadmap/rebuild.md](../roadmap/rebuild.md) records how, the decisions
behind it, and what is designed but not built yet (variables, secrets
and services).

## Architecture

- [overview.md](architecture/overview.md): the shape of the system,
  the pieces and how they fit. Start here.
- [agent-loop.md](architecture/agent-loop.md): a turn, from the
  composer to the stored run: models and providers, thinking, folding,
  notes mid-turn, interrupted runs, the primer, and delegation.
- [code-and-tools.md](architecture/code-and-tools.md): the TypeScript
  kernel, the agent's tools, the studio's host objects (`web`,
  `media`, `pdf`), skills, and `ui` artifacts.
- [app-preview.md](architecture/app-preview.md): the apps origin and
  its bootloader, building an app's page, the bridges between the app
  and the studio (storage, cache, `notify`, `agex.task`), and
  `test_app`.
- [sessions-and-storage.md](architecture/sessions-and-storage.md):
  the store, sessions as branches, what the studio keeps on its plane,
  undo, forks, bundles, sync, and publishing to gists.
- [errors-and-recovery.md](architecture/errors-and-recovery.md):
  what happens when something goes wrong, and what the person can do
  about it.

## Operations

- [deploy.md](operations/deploy.md): the build, hosting, and the
  deploy-day checklist.

## Conventions for these docs

- **The audience is someone about to touch the code.** Terse, with
  file and function names, assuming familiarity with the agex stack
  (see agex-ts's own README for the world and the loop).
- **Invariants and reasons, not mechanics.** The code holds the
  mechanics; these say why, and what would break if it changed.
- **When something here goes stale, fix it or delete it.** A
  half-right doc is worse than none.
