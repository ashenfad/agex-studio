# Getting started

**agex.studio is a tool, not a service.** It's a webpage that runs an
AI agent in your browser: no account to create, no subscription, no
server of ours in between.

The model runs somewhere else: at a provider you choose, paid with
your own key. Your messages, your files, your costs.

Think of it less like a chat service and more like an editor you keep
open in a tab, with your own data and your own model plugged in.

---

## What you need

Access to a model, one of two ways:

- **OpenRouter** *(recommended)*: one account and one key for models
  from many providers. It also powers the agent's web search and its
  images, speech and music, which need an OpenRouter key.
- **An endpoint of your own**: any service that speaks Anthropic's
  Messages API (a local proxy such as Meridian, say) or the
  OpenAI-compatible API (a local model server, a self-hosted router).
  Useful for local models and private setups. Add an OpenRouter key
  beside it and the agent keeps its web search and media.

### OpenRouter setup

**[Sign up at openrouter.ai →](https://openrouter.ai/)**, then create
a key under **[Keys →](https://openrouter.ai/settings/keys)** and copy
it.

---

## Settings

Click the **⚙** at the top right.

- **Service**: OpenRouter, or an endpoint of your own (then its
  **Shape**, Anthropic or OpenAI-compatible, and its **URL**).
- **Key**: your OpenRouter key; with an endpoint of your own, the
  endpoint's key, if it needs one.
- **OpenRouter key (optional)**, with an endpoint of your own: for the
  agent's web search and its images, speech and music, which run on
  OpenRouter whatever the model. It goes only to OpenRouter, never to
  your endpoint.
- Under an OpenRouter key, either one, a line says whether OpenRouter
  accepts it and what it has spent today and this month (and what's
  left, for a key with a limit). It's checked when settings open, and
  again once you stop typing.
- **Model**: on OpenRouter, pick from its list as you type (each with
  its context size, its price per million tokens and whether it takes
  images; models that can't call tools are hidden, since the agent
  needs them), or type any model's id; `google/gemini-3.8-flash` is
  the default. With an endpoint of your own, the endpoint's name for
  its model. Each service keeps its own, so switching back and forth
  doesn't lose either.
- **Provider for this model**, on OpenRouter: which of the providers
  serving the model takes its requests, each with its price and recent
  uptime. Auto lets OpenRouter pick, optionally preferring the lowest
  price, highest throughput or lowest latency. A chosen provider is
  tried first, falling back to others if it's down unless you tick
  **Only this provider**. Each model keeps its own choice.
- **Skip providers that may train on my prompts** and **Zero data
  retention only**, on OpenRouter, for every model: keep to providers
  whose stated policy is not to store or train on prompts, or to
  endpoints that keep nothing of a request once it's answered. Fewer
  providers qualify; when none does, requests fail.
- **Thinking**: how hard the model thinks each turn: off, low,
  medium or high. Greyed out for an OpenRouter model that doesn't
  reason.
- **The model takes images**, with an endpoint of your own (or a
  model OpenRouter doesn't list): tick it for a model that reads
  images, so it can look at screenshots of the apps it builds and at
  images you give it. Untick it for one that doesn't; the agent then
  checks its work by text. On OpenRouter, its list says.
- **Fold the conversation past**: once a conversation is longer than
  this many tokens, its earlier part is folded into a summary for the
  model (the chat still shows all of it). 0 never folds. On
  OpenRouter, it folds by three quarters of the model's context window
  at the latest, whatever this says.
- **Notify me when a turn ends while I'm away**: a desktop notification
  when the agent finishes (or fails) while you're in another session,
  tab or app. Turning it on asks your browser's permission. See
  [Sessions](#sessions).

The same dialog holds **Sync** (keep your sessions in a GitHub repo of
your own, to use them on another device; see [Sessions](#sessions))
and **Publishing** (share a session as a link; see
[Sharing](#sharing)).

Your keys are kept in your browser's storage on this device, each
sent only to the service it's for.

> [!NOTE]
> Another browser or device means entering your key again: there's no
> account to remember you.

---

## Where your data lives

In your browser, for this site:

- **localStorage**: your settings and keys, and the data apps save.
- **IndexedDB**: your sessions: their files, conversations and
  history.

Clearing the site's data in your browser wipes it all. Other copies
exist only where you put them: a GitHub repo you sync to, a gist you
publish, a bundle you export.

---

## What it costs

That depends on the model you pick and what you ask for. A short
question costs a fraction of a cent on a small model; building and
testing an app takes many model calls and costs more. Your provider's
dashboard shows exactly what you've spent. You can change the model
any time; the next turn uses it.

---

## Your first message

Give the agent something to *do*:

- "Build me a study app for 4th-grade multiplication."
- "Chart this CSV for me." *(after adding it in the Files tab)*
- "Find three recent articles on diffusion models and summarize each."
- "What are the key claims in this PDF?" *(after adding one)*

See [The agent](#the-agent) for what it can do.
