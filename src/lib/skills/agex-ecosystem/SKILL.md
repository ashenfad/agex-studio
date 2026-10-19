---
name: agex-ecosystem
description: What this workspace is built from — agex studio, agex-ts, and its world, kvgit, termish and kvsql packages; how they fit together, with each one's README. Read it when asked about any of them, or to explain or present them.
---

# The stack under this workspace

You are working inside **agex studio**. What you see as a terminal, a
TypeScript tool and versioned files is a handful of small TypeScript
packages, each doing one job, running in the person's browser tab.

```
agex studio        the web workbench: chat, live app preview, sharing
└─ agex-ts         the agent loop: sessions, tasks, delegation, folding
   └─ @agex-ts/world     the workspace: files, cache, shell, code, tools
      ├─ @agex-ts/termish   the terminal: shell commands over the files
      └─ @agex-ts/kvgit     the versioning: commits, branches, merges
         └─ @agex-ts/kvsql  apps' SQLite databases, logged to kvgit
```

## What each one is

- **agex studio** is a browser workbench with no server of its own. A
  person chats with an agent working in a versioned workspace; the
  agent runs on the person's own model key, and sessions live in their
  browser (IndexedDB). Undoing a turn rewinds files and conversation
  together; a session can be forked; what is under `/workspace/app`
  shows as a live preview, checked with `test_app`, and a session can be
  published as a link.
- **agex-ts** is the loop: an agent that acts by writing TypeScript and
  running a shell, on any AI SDK model. Sessions, typed tasks (a
  function a helper agent answers: `agex.task`), delegation to forks of
  itself, and folding a long conversation into a summary.
- **@agex-ts/world** is the workspace the agent acts in: sessions as
  branches of one repository, each holding files, a cache, a working
  directory and the conversation. It runs the agent's code in a Web
  Worker, gives it the tools (`run_ts`, `terminal`, the file tools,
  `view_image`), host objects such as `web` and `media`, skills, the
  inbox that carries messages mid-turn, and `ws-git`, the agent's own
  git.
- **@agex-ts/termish** is a shell interpreter in TypeScript: pipes,
  redirects, heredocs and variables over the workspace's files. It is
  not bash. When a command or a flag you expect is missing, that is
  termish, not a broken machine.
- **@agex-ts/kvgit** is git-style versioning over a key-value store:
  commits, cheap branches, three-way merges, tags that keep a commit
  alive, and sync. A studio session is a kvgit branch, and the
  conversation lives in the same branch as the files.
- **@agex-ts/kvsql** is SQLite in the browser with its changes logged
  to kvgit: the database file in the origin-private file system, one
  writer across tabs, and every transaction's changes recorded on a
  kvgit branch, so the file can be rebuilt from the log. It is what an
  app's `agex.db` runs on.

These are the TypeScript counterparts of Python projects by the same
author: **agex** (the loop), **nontainer** (the workspace), **kvgit**
and **termish**. They are kept aligned on meaning rather than bytes,
except kvgit, whose storage format is the same byte for byte. kvsql
has no Python counterpart.

## The READMEs

`references/<name>.md` is each package's README as this studio was
built with it, its first line naming the version:

```sh
ls /workspace/skills/agex-ecosystem/references/
cat /workspace/skills/agex-ecosystem/references/world.md
```

`agex-studio.md` is the studio's own. Links inside point at the source
repositories, which are not in this workspace.

Treat the READMEs as the source of truth over this page. When you
explain or present these projects, say what they say, and leave out
features they do not mention.
