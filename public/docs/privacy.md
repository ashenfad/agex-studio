# Privacy

*Last updated: 2026-10-14.*

## What agex.studio is

A static webpage that runs an AI agent in your browser. There is
no agex.studio server. All computation, storage, and state lives
on your device. Conversations go to whichever LLM provider you've
configured, using your own API key. For the broader framing see
[Getting started](#getting-started).

## Data that stays in your browser

Your sessions, files, message history, agent state, apps' saved
data, and settings are stored in your browser's IndexedDB and
localStorage. None of this leaves your device unless you
explicitly trigger an action that connects to an external
service, with one exception: apps.

An app is code, written by the agent or, for one you imported or
opened from a published link, by someone else's agent. It runs in
the preview with network access, like any web page, so it can send
what you enter into it, and its own saved data, wherever its code
says. Open apps from people you trust, as you would any website.

The agex.studio static site itself uses no analytics, no tracking
pixels, no cookies, and no form of user identification. Loading
the site fetches its static files, and its fonts from Google
Fonts. The app preview loads a small static page from
apps.agex.studio, and your app is handed to it inside your
browser. None of these requests carry your data, and nothing on
the page calls back to a server we control, because there is no
server we control.

## External services

agex.studio connects out only when you choose to:

- **Your LLM provider.** When you send a message, your
  conversation history is sent to whichever provider you have
  configured (OpenRouter, or an endpoint of your own speaking
  Anthropic's Messages API or the OpenAI-compatible API). An app
  that calls an agent sends its request to the provider of
  whoever is using the app, on their key. Their privacy practices
  govern that traffic; see their respective policies for details.
- **Web search, page reading and media.** When the agent searches
  the web, the query is routed via Perplexity's Sonar through
  OpenRouter using your key; when it reads a page, OpenRouter
  fetches the page it names. When it makes images, speech or
  music, the prompt (and any images it works from) goes to
  OpenRouter. These may include short excerpts from your
  conversation that the agent decides are relevant.
- **Google Drive (file picker).** When you use **From Drive** in
  the Files tab, the studio requests the `drive.file` scope —
  access only to the specific files you select through Google's
  own picker UI. API calls go directly from your browser to
  Google. The studio does not relay, store, or retain your Drive
  data; selected files become uploads to your local workspace.
- **GitHub sync.** If you turn on sync, your sessions and their
  apps' saved data are written to a GitHub repository you choose,
  using a token you've supplied. The repository is governed by
  GitHub's terms.
- **GitHub gists.** When you publish a session, the bundle is
  written to a secret gist on github.com under your account,
  using a GitHub token you've supplied. The gist is governed by
  GitHub's terms; the studio does not retain a copy of what was
  published. Opening a published link fetches the gist from
  GitHub, and the studio later asks GitHub whether it has a newer
  version.
- **Code packages.** When the agent's code or an app imports a
  package, it is fetched from esm.sh. Charts load Plotly from
  cdn.plot.ly, and PDFs load pdf.js from jsDelivr. These requests
  name the package, not your data.

## Google API scopes

The only Google scope currently requested is:

- `drive.file` — access only the files you explicitly select
  through the Google file picker. Per Google's policy, this
  scope can't list or read any file you haven't picked
  yourself.

Broader scopes (calendar, full Drive access) are not currently
in use. Once the studio earns Google's app verification for
sensitive scopes, additional integrations may be added; the
options will appear in Settings if and when that happens.

Your Google OAuth token is kept only for the import it was asked
for, is sent only to Google's APIs, and is not stored.

## Deletion

- **Sessions**: delete them from the session list, which removes
  each one and its app's saved data. Your settings stay, keys and
  tokens included.
- **All local data**, settings, keys and tokens included: clear this
  site's data in your browser's settings.
- **Synced sessions**: delete them everywhere from the session
  list and empty the trash, or delete the repository on GitHub.
- **Google access**: visit your
  [Google account permissions](https://myaccount.google.com/permissions).
- **Published gists**: must be deleted on github.com directly
  since the studio never deletes a gist.

## Contact

Privacy questions: open an issue at
[github.com/ashenfad/agex-studio](https://github.com/ashenfad/agex-studio/issues).
