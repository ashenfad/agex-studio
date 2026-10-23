---
name: delegation
description: Split a build across delegates (`sessions ask`) so their work merges and fits — when splitting pays and when it doesn't, the contract file and owned paths to write first, a brief that stands alone, sequencing pieces that depend on each other, bringing each answer back and checking the seams. Read it before handing work to two or more delegates; a delegate reads its last section before it reports.
---

# Delegation

A delegate is a fork of this session: a whole agent on the person's
model, with its own copy of the workspace, working on a branch of its
own while you go on. Its answer comes back to you by itself. Each one
costs a brief to write, an answer to review and a merge, so delegation
pays for **large pieces that can be built apart**, and not for much
else.

## When to delegate

**Worth it:**
- several pieces, each many turns of work, with a boundary between them
  you can write down (systems of a game, pages of an app, scenes of a
  video, a backend and a frontend);
- research or reading that would fill your context, where you need only
  the conclusion.

**Do it yourself instead:**
- short loops of edit, run and read: tuning numbers, polish, a bug you
  can see. Briefing one takes longer than doing it.
- work whose design isn't settled yet. Settle it first; a delegate
  can't ask you mid-task.
- anything small: two or three files, a single module.

**How many:** two to five. Each is a whole agent; past that, the briefs,
reviews and merges cost more than the parallel work saves.

**If you are a delegate,** do your task yourself unless your brief says
to split it.

## Before you ask: the skeleton

Delegates start from your files as they are when you ask, and none of
them sees the others' work until you merge it. Everything they share has
to be in the files first.

1. **The contract, in a file** (`PLAN.md`, say). For each piece: what it
   does, the paths it owns, and every name that crosses a boundary:
   - function signatures, with the shapes they take and return;
   - ids, event names, storage keys, CSS classes, routes;
   - enum values (tile types, item kinds, states), listed in full;
   - which file imports which.

   A name a delegate has to guess, it guesses differently from the next
   one. "The map uses tile types" leaves `wreck` versus `ruin` to luck;
   "tile types: `floor`, `wall`, `wreck`, `water`" doesn't.
2. **The shared skeleton, written by you:** the page and its styles, the
   modules each piece imports (stubs with the real signatures), seed
   data, and a stub or mock for anything one piece calls on another, so
   each delegate builds and tests against something real-shaped.
3. **One end-to-end check** a delegate can run: a `test_app` script (or
   a test) that goes through the whole flow, the real UI included. Unit
   tests passing on each side is not the same as the pieces fitting.
4. **Read the contract for joins** before you fork. For each boundary:
   does one side produce exactly what the other takes? Can every feature
   be reached (the tab that unlocks it, the link to the page)? Gaps found
   here cost one edit; found after the fork, they cost a delegate's run.
5. **Commit:** `ws-git add -A && ws-git commit -m 'skeleton'`. A merge
   takes only what is committed on both sides.

## Ownership

Give each delegate its own paths, disjoint from the others' and from
yours (`app/systems/hearth/`, `tests/hearth.test.js`). It writes only
there. That is what makes every merge clean.

- **Shared files are yours:** the page, the contract, the file that
  wires the pieces together. You change them, after merging.
- **A fix outside its paths** (a bug in shared code, a gap in the
  contract) the delegate reports in its answer, with the change it would
  make, rather than making it. You apply it once, for everyone.

## Sequence what depends on what

If one piece consumes another's output (art generated from the content,
a balance page that needs the real engine, a summary of research), don't
run both at once on a guess. Either:
- **fix the input in the contract** (the list of ids the art keys off,
  the engine's interface), so both sides build to it now; or
- **ask in order:** the first, merge it, then the second, on your tree
  as it is then.

## The brief

A delegate starts with no memory of this conversation: its task is all
it is told. Keep what the delegates share in the contract file and the
task short, so you don't paste the same preamble into each:

```
You are building <the piece> of <the project>. Read /workspace/PLAN.md
first: it is the contract, and your part is "<its section>".

You own: <paths>. Write only there. If something outside them is wrong
or missing, don't change it: say what in your answer, with the change
you would make.

Done means: <what it does, concretely>; <its tests> pass; <the
end-to-end check> runs.

Known quirks: <anything you or an earlier delegate found the hard way>

When you're done, commit only your paths, by name (not add -A):
  ws-git add <paths> && ws-git commit -m '<the piece>'
Then answer with: what you built and its files; the tests you ran and
their counts; how you checked the boundaries (which calls into the
others you exercised, and how); what you didn't verify; and any change
needed outside your paths.
```

**`inherit="full"`** gives the delegate your conversation (as of your
last commit) instead of a fresh start. It carries your whole context
into every one of its calls, so use it only when what it needs is long
and hard to write down, and commit first. Otherwise, the default fresh
start and the contract file.

## Asking

- **Ask them all in one turn,** one `sessions ask` each, with a `name`
  that says what the piece is (`name="hearth"`): its branch, answer and
  transcript read by that name.
- **Leave `paths` out.** It narrows what the delegate sees, not what it
  owns; a narrowed delegate can't run the whole app or its tests.
- **Then keep working, or end your turn** saying what you are waiting
  for. Work only outside their paths meanwhile (the wiring, docs, the
  next skeleton). Each answer comes with your next tool result, or
  starts a turn of its own; don't poll `sessions list` or `result`.

## Bringing it back

For each answer:

1. **Read it as evidence, then check it.** `ws-git diff <name> --stat`:
   did it touch only its paths? Do its files match what it says it
   wrote?
2. **Commit your own work first.** A merge refuses uncommitted changes.
3. **Take the work:** `ws-git merge <name>` when it stayed in its paths;
   otherwise `ws-git checkout <name> -- <its paths>`, which leaves its
   stray files and test edits behind.
4. **Run its tests yourself,** on your tree.
5. **Revise** with `sessions ask resume="<name>" task="…"`: it goes on
   from its own branch, its conversation kept. New work on your tree as
   it is now is a new ask.

A change one delegate reported outside its paths, you make. One still
running can't hear about it; tell it when you resume it, or fix its
side after merging.

## Checking the seams

With everything merged, swap each stub for the real piece and run the
whole thing end to end (`test_app` through the real UI, for an app).
That is where the bugs between pieces show:
- a name or shape one side changed and the other didn't;
- paths that resolve somewhere else than expected: `url()` in CSS is
  relative to the stylesheet, `fetch` and `import` to the page;
- a value that never gets passed through (an id, a setting);
- a worker or module that behaves differently loaded for real than in
  its own test.

Fix seams yourself: it's a short loop, the kind not worth briefing.

## As a delegate

- **Your answer is all that reaches the session that asked.** Lead with
  the result, in plain prose; no notes to yourself.
- **Stay in your paths,** and commit them by name, not with `add -A`
  (which takes scratch files and caches with it).
- **A gap in the contract:** take the least surprising reading, say
  which you took, and go on. There is no way to ask mid-task.
- **Report** what you built and its files, the tests you ran with their
  counts, how you checked the boundaries, what you didn't verify, and
  any change needed outside your paths.
