# Roadmap

Forward-looking design proposals — work not yet shipped. Once a
proposal lands, its durable parts move into [`docs/`](../docs/) (which
documents how things work *today*) and the proposal is pruned or marked
done.

- [concurrent-sessions.md](concurrent-sessions.md) — run sessions in
  the background / concurrently. Two-phase: lift the agent loop out of
  `ChatShell` (storage-agnostic), then per-session kvgit working trees.
