# Agex Studio — implementation docs

How the studio is put together. Aimed at someone (human or agent)
who's about to touch a piece of the codebase and wants the context
that isn't in the code or git history.

For "what is this and how do I use it," see the
[project README](../README.md). For forward-looking proposals (work
not yet shipped), see [roadmap/](../roadmap/).

## Architecture

How things work today.

- [overview.md](architecture/overview.md) — system shape, the
  pieces and how they fit. Start here.
- [kernels.md](architecture/kernels.md) — TS vs Py kernels, the
  `KernelAdapter` contract, what's shared, what's per-kernel.
- [sessions-and-storage.md](architecture/sessions-and-storage.md)
  — kvgit branches as sessions, the key-prefix map, commit
  timing, fork / undo / export semantics.
- [app-preview.md](architecture/app-preview.md) — the iframe
  preview pipeline, `buildAppHtml`, `testApp` vs `liveApp`,
  asset inlining, message-passing protocol.
- [agent-loop-and-tokens.md](architecture/agent-loop-and-tokens.md)
  — TokenChunk stream from agex-ts through the adapter into
  `ChatShell` + `MessageList`. Cancellation paths.
- [errors-and-recovery.md](architecture/errors-and-recovery.md) —
  what happens when things go wrong. LLM errors, worker
  crashes, agent task failures, the chat-level error bubble.

## Operations

How to run, maintain, and deploy.

- [deploy.md](operations/deploy.md) — GitHub Pages + custom
  domain, the build pipeline, deploy-day smoke checklist.

## Conventions for these docs

- **Audience is "someone about to touch the code."** Terse,
  code-pointer-heavy (`file.js:NNN`), assumes literacy with the
  agex stack.
- **Capture invariants and rationale, not mechanics.** Mechanics
  live in the code; the docs cover *why* and *what would break if
  you changed this*.
- **When something here goes stale, update or delete it.** A
  half-right doc is worse than no doc.
