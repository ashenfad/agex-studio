# Privacy

*Last updated: 2026-05-19.*

## What agex.studio is

A static webpage that runs an AI agent in your browser. There is
no agex.studio server. All computation, storage, and state lives
on your device. Conversations go to whichever LLM provider you've
configured, using your own API key. For the broader framing see
[Getting started](#getting-started).

## Data that stays in your browser

Your sessions, files, message history, agent state, and settings
are stored in your browser's IndexedDB and localStorage. None of
this leaves your device unless you explicitly trigger an action
that connects to an external service.

The agex.studio static site itself uses no analytics, no tracking
pixels, no cookies, and no form of user identification. The
single HTTP request to load the site is a vanilla GET; nothing
on the page calls back to a server we control, because there is
no server we control.

## External services

agex.studio connects out only when you choose to:

- **Your LLM provider.** When you send a message, your
  conversation history is sent to whichever provider you have
  configured (OpenRouter, OpenAI, Anthropic, or a custom
  OpenAI-compatible endpoint). Their privacy practices govern
  that traffic; see their respective policies for details.
- **Web search.** When the agent performs a web search, the
  query is routed via Perplexity's Sonar through OpenRouter
  using your key. The query may include short excerpts from
  your conversation that the agent decides are relevant.
- **Google Calendar and Drive.** When you connect a Google
  account in Settings, the studio requests scoped permissions
  (see below). API calls go directly from your browser to
  Google. The studio does not relay, store, or retain your
  Google data.
- **GitHub gists.** When you publish a session, the bundle is
  written to a secret gist on github.com under your account,
  using a GitHub Personal Access Token you've supplied. The
  gist is governed by GitHub's terms; the studio does not
  retain a copy of what was published.

## Google API scopes

If you connect Google, agex.studio asks for:

- `calendar` — read and write calendar events.
- `drive.file` — access only the files you explicitly select
  through the Google file picker.

Your Google OAuth token is stored in your browser's localStorage
and is sent only to Google's APIs.

## Deletion

- **All local data**: use **Purge all data** in the sessions
  drawer.
- **Google access**: disconnect in Settings, or visit your
  [Google account permissions](https://myaccount.google.com/permissions).
- **Published gists**: must be deleted on github.com directly
  since the studio doesn't track which gists you've created.

## Contact

Privacy questions: open an issue at
[github.com/ashenfad/agex-studio](https://github.com/ashenfad/agex-studio/issues).
