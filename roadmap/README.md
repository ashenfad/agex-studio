# Roadmap

Forward-looking design proposals — work not yet shipped. Once a
proposal lands, its durable parts move into [`docs/`](../docs/) (which
documents how things work *today*) and the proposal is pruned or marked
done.

- [rebuild.md](rebuild.md): the studio rebuilt on the new agex-ts (one
  TypeScript kernel, the world's sessions and tools): what goes, what
  stays, and the steps.
- [app-db.md](app-db.md): `agex.db`, a SQLite database for apps, kept
  in an OPFS file with a changeset log in kvgit for checkpoints and
  sync between devices.
- [app-agents.md](app-agents.md): agents in apps (agex-ts in the
  page, on the viewer's model through `agex.model`), then an app's
  needs and secrets, the agent's secrets and variables (the rebuild's
  S6).
- [browser.md](browser.md): agents in the person's browser, through
  an extension: tabs the agent opens and drives (searching a dozen
  hotels at once), tabs the person shares, and the cards the agent
  asks the person with (sites, confirmations, handoffs).
