# Getting started

**agex.studio is a tool, not a service.** It's a static webpage that runs
an AI agent inside your browser. There's no company behind it collecting
your data, no account to create, no subscription to manage, no servers to
talk to.

The trade-off: the LLM has to run *somewhere*, and that somewhere is a
provider you choose, paid for with your own API key. Your messages, your
files, your costs — all yours.

Think of it less like ChatGPT and more like VS Code: a tool you keep open
in a tab, with your own data and your own external services plugged in.

---

## What you need

One thing: an **API key from OpenRouter**.

OpenRouter is a third-party gateway that lets you reach hundreds of LLMs
(Anthropic, Google, OpenAI, open-source models) through a single account,
with a single bill. It's the path of least resistance for getting started —
the studio also supports raw OpenAI and Anthropic keys for users who
prefer to deal direct, but those require separate accounts per provider.

**[Sign up at openrouter.ai →](https://openrouter.ai/)** — it takes about
a minute. New accounts get a small free credit balance you can use to try
the studio before adding payment info.

Once you're in, head to **[Keys →](https://openrouter.ai/settings/keys)**,
create a new key, and copy it.

---

## Pasting your key

1. Click the **gear icon** at the top-right of the editor.
2. Paste your key into the **OpenRouter API key** field.
3. Pick a model (the default is a good starting point — capable but
   inexpensive).
4. Close the settings drawer and start typing.

Your key is stored in your browser's `localStorage` and used only when
making requests directly to OpenRouter. It never touches an agex.studio
server — there isn't one.

---

## What it actually costs

Wildly variable, but rough order of magnitude:

| Activity | Typical cost |
|---|---|
| Casual chat (a few questions) | well under a cent |
| Building a small interactive app | a few cents to ~$0.50 |
| Long data-analysis session with charts | $0.50–$2 |

The token meter at the top of the chat shows you exactly how much context
you've used. OpenRouter's dashboard shows you exactly what you've spent.
Nobody else is in the loop.

You can swap to a cheaper or stronger model anytime in Settings — the
studio will use whichever model you've picked for the next turn.

---

## Where your data lives

Inside your browser. Specifically:

- **`localStorage`**: your API key, session pointer, UI preferences.
- **`IndexedDB`**: your sessions, their event logs, agent state, and any
  files in the agent's workspace.

Clearing your browser's data for `agex.studio` wipes everything. There's
no other copy unless you've exported a session bundle yourself (see the
sessions drawer's "Export" option) or published a session to a GitHub
gist (which lives on github.com, under your account, controlled by you).

---

## Your first message

Try something concrete. The studio's agent is most fun when you give it
something it can *do*, not just answer:

- "What's in this CSV?" *(after dragging a CSV into the chat input)*
- "Build me a study app for 4th-grade multiplication."
- "Find me three recent papers on diffusion models and summarize each."
- "Render this PDF and pull out the key claims." *(after attaching one)*

The agent has TypeScript code execution, web search, PDF rendering, an
interactive-app preview pane, and a virtual filesystem available. Most of
those surface naturally when you ask for the right thing.

Welcome in.
