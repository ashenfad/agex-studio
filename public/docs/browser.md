# Browser tabs

With the studio's extension in Chrome, the agent can work in real
browser tabs. It opens the sites you allow it, to search, compare and
fill in forms, and it reads a tab you share with it, or acts in it.
Without the extension the agent has no browser tools. It needs Chrome
on a computer: mobile browsers can't run extensions like it.

## What it can do

The extension uses Chrome's **debugger** permission, which can read
and control any tab. It uses it only:

- **In the tabs it opens for a session's agent**, on the sites you've
  allowed that session (each with its subdomains). Every page load in
  those tabs is held to those sites: a page that goes on to another
  site is stopped. The tabs open in the background, in a tab group
  named for the session.
- **In a tab you share** from its toolbar button, while that tab stays
  on the site you shared. You choose whether the agent may only read
  it or act in it too, and can stop sharing at any time.

It never reads or lists your other tabs. While the agent works in a
tab, Chrome shows its "started debugging this browser" bar, and the
tab's title starts with 🤖; the bar's **Cancel** stops the agent's work
in every tab until its next turn. A button that commits you to
something (book, pay, send, post, delete) waits until you confirm it
in the studio.

The extension answers agex.studio and nothing else. What the agent
reads in a tab goes into its conversation, and so to your LLM
provider, like anything else it reads.

## Installing

It isn't in the Chrome Web Store yet, so Chrome loads it from a folder:

1. [Download the extension](/extension/agex-studio-extension.zip) and
   unzip it. Keep the `agex-studio` folder somewhere it can stay:
   Chrome loads it from there each time it starts.
2. Open `chrome://extensions` and turn on **Developer mode** (top
   right).
3. Click **Load unpacked** and choose the `agex-studio` folder.
4. Reload agex.studio. **⚙ Settings → Keys** says the extension is
   here, under *Sites your agents may open*.

Pin it from Chrome's puzzle-piece menu to have its toolbar button,
for sharing a tab, at hand.

## Updating

It doesn't update itself. When the studio says a newer one is out,
download it again, put the new `agex-studio` folder where the old one
was (replacing it), and click **↻** on its card in
`chrome://extensions`.

## Removing

Click **Remove** on its card in `chrome://extensions`. The tabs it
opened stay open, as ordinary tabs.
