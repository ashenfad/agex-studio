# Sharing

A session stays on your devices until you share it. Publishing puts
it in a **secret GitHub gist** under your account, and gives you a
link that opens it. There's no agex.studio server in between.

## What you need

A GitHub token that can write gists, one of:

- a [classic token](https://github.com/settings/tokens/new?description=agex-studio&scopes=gist)
  with the `gist` scope, or
- a fine-grained token with the account permission *Gists: read and
  write*.

Paste it in **⚙ Settings → Publishing**. If you sync and leave this
empty, the sync token is tried; a fine-grained sync token works if you
also gave it the Gists permission.

> [!NOTE]
> Secret gists aren't listed on your profile or in search, but anyone
> with the link can see them. Treat a published session like a link
> you share, not a private document.

## Publishing

From a session's **⋯** dialog, choose **Publish…**:

- **As it is now** (the default): its files and conversation, without
  the history. Smaller.
- **With its history**: every commit, so viewers can undo its turns.

Tick that you understand anyone with the link can see all of it, then
**Publish**. You get two links, each with **Copy**:

- **The app alone**: the app fills the screen. For people who just
  want to use it.
- **The app and how it was made**: the studio, with the app beside
  the conversation that built it.

There's also a link to the gist on GitHub.

### Publishing again

Publishing the same session again **updates the same gist**, so the
links keep working, and people who opened it are offered the new
version. To publish separately, tick **As a new gist**. If the old
gist was deleted, a new one is made, and the dialog says so.

## Opening a published session

A link opens the studio and brings the session into **your** browser,
as a session of your own: browse it, fork it, carry on the
conversation, publish your own version. Opening the same link again
goes to the copy you already have.

- **The app alone** shows just the app, with a small **agex studio ·
  how it was made** button to see the rest.
- **Without a model**, a visitor can still use the app and read the
  conversation. To carry the conversation on, they choose a model in
  Settings.
- **Updates**: the studio checks now and then (at most every 12 hours)
  whether a published session you opened has a newer version, and
  offers it in the session list: **Open it** or **Not now**. If you
  haven't changed your copy, the new version replaces it; if you have,
  it opens beside it.
- An app that calls an agent runs those calls on **the visitor's**
  model, and asks them first. See [The agent](#the-agent).

## What a published session holds

**Included:** the session's files and its conversation (with the
history, if you chose that). That means anything the agent could see:
files you uploaded or brought in from Drive, what it fetched, what it
wrote. Before publishing, look through the **Files** tab and
remove anything private.

**Not included:** your settings and keys, your tokens, the data the
app saved while you used it, and anything else in your browser outside
the session.

## Removing a published session

The studio doesn't delete gists. Delete one on
[gist.github.com](https://gist.github.com); its links stop working.
Copies people already opened stay in their browsers.
