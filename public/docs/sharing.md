# Sharing and gallery

Sessions stay on your device until you decide otherwise. When you
want to share one — with a friend, a class, the gallery — the
studio packages it as a single binary bundle and pushes it to a
secret GitHub gist under your account. There is no agex.studio
relay in between.

## What you need

A GitHub Personal Access Token with **gist** scope. One-time
setup:

1. Visit **[github.com/settings/tokens →](https://github.com/settings/tokens)**
   and create a token (classic or fine-grained both work).
2. Grant it the `gist` scope and nothing else. Sharing this
   token's powers is limited to creating, updating, and deleting
   gists on your behalf.
3. In the studio: **Settings → GitHub token**. Paste and save.

The token lives in `localStorage`, sent only to `api.github.com`
when you publish. Revoking it on GitHub immediately cuts the
studio's access.

> [!NOTE]
> Published gists are *secret*, not private. Secret gists aren't
> listed on your profile and aren't search-indexed, but anyone
> with the URL can view them. Treat published sessions like a
> link-share, not a password-protected document.

## Publishing a session

In the active session's row, click the gear icon to open
**Session settings**. Set a title and optional description if you
haven't already, then click **Publish to gist**. The studio
bundles the session, pushes it to a new gist, and posts a
markdown comment on the gist carrying:

- The session title and description.
- Two share URLs (more on those below).
- A small stats table (commits, blobs, nodes, bundle size).

The gist itself contains a single `.agex.b64` file — the binary
bundle, base64-encoded so GitHub renders it as text.

After publishing, a confirmation panel shows the two share URLs
with copy buttons, a link to the gist on GitHub, and a **Submit
to gallery** button (covered below).

## Republishing (PATCH on update)

When you publish a session that's been published before, the
studio updates the existing gist via PATCH instead of creating a
new one. The mapping lives in `localStorage`
(`agex-session-gist-<branch>`); clearing browser data resets it
and the next publish will create a fresh gist.

If the original gist has been deleted on GitHub, the studio
falls back to creating a new one and surfaces a notice.

## Two URLs per publish: play vs showcase

Every publish produces one share URL with two modes:

- **Play** (`...&play=1`) — opens app-only view. The interactive
  app fills the screen, no chat history visible. Use for end-users
  who just want to *use* the thing.
- **Showcase** (without `&play=1`) — opens split view: app on
  one side, full chat history on the other. Use for builders or
  curious folk who want to see how it was made.

Both URLs point at the same gist. Recipients without an API key
can still play (and inspect) — viewer mode kicks in automatically.

## Importing someone else's session

Open a share URL and the studio resolves the gist, downloads the
bundle, and imports it as a new local session. The original
publisher's name and description ride along; the imported session
is yours to fork, edit, or republish from your own account.

Imports deduplicate: opening the same gist twice surfaces the
existing local session instead of creating a duplicate.

If you don't have an API key set, viewer mode loads the
interactive app read-only — you can play the app and browse the
history, just not continue the conversation.

## Gallery submission

The gallery on **[agex.studio/gallery/](https://agex.studio/gallery/)**
collects sessions worth showing off. To submit one:

1. Publish the session.
2. On the publish-success panel, click **✨ Submit to gallery**.
3. The studio opens a prefilled GitHub issue against the
   `agex-studio` repo, with the session title, description, the
   pinned URL, and tag suggestions.
4. Attach a screenshot of the app or a representative chart, then
   submit the issue.

Submissions are reviewed manually; accepted entries appear in
the gallery with a thumbnail, title, description, and two
buttons: **Try it** (play mode) and **See how** (showcase mode).

> [!NOTE]
> Gallery entries pin to the specific gist version you submitted,
> so they keep working unchanged even if you later republish the
> session.

## Deletion

- **Unpublish a session locally**: clearing browser data removes
  the `agex-session-gist-<branch>` mapping; the next publish
  creates a new gist instead of updating the old one.
- **Delete a published gist**: do this on github.com directly —
  the studio doesn't track which gists you've created beyond
  the per-session mapping, and there's no "delete remote" button.
- **Remove a gallery entry**: comment on the original submission
  issue or open a new one referencing it.

## What gets shared

The bundle is a full snapshot: every commit, every file in the
workspace, the agent's memory state, the chat history. Anything
the agent could see during the session is in there. Before
publishing, look through the **Files** drawer and prune anything
sensitive — uploaded PDFs, API responses cached in the
workspace, anything that came in over the Drive picker.

Settings (API keys, GitHub token, etc.) are *not* part of the
bundle. Those stay in `localStorage` on your device only.
