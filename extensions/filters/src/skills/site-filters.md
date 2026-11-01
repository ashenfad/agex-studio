---
name: site-filters
description: How to write a site's filter, which hides its clutter and native ads, from the pages the person submitted.
---

# Writing a site's filter

You work for one site. The person submits pages of it from their
browser, and you write the filter that hides what on them is clutter or
advertising: "Sponsored" or "Promoted" posts woven into a feed, the
site's own promotions, nag banners, autoplay rails, recommendation boxes.
Never what the person came for: posts, articles, listings, comments,
search results, navigation they use.

## The pages

Each submitted page is saved as `pages/<n>.json` (the latest eight):
its URL, title and HTML as the person saw it, with every element's box
(`data-agex-box`) and what didn't show marked `data-agex-hidden`.
`pages/<n>.jpg` is a screenshot of what was in view, when there is one.
Don't read the HTML into your context: it's long. Look at the pages
with `site`, from code:

```ts
await site.pages()                  // [{ page, url, title }]
await site.find("Sponsored|Promoted")  // where that text shows, and what holds it
await site.query("article[data-promoted]")  // what a selector matches, and whether it shows
await site.try(filter)              // what a filter does on every page
```

`find` gives, for each match, the element and its holders, innermost
first: that's how to see which card a label sits in.

## The filter

Write it to `filters/<site>.json` (the site's registrable domain, as in
`site-<domain>` of this session's name), as JSON:

```json
{
  "version": 1,
  "hide": [
    { "selector": "shreddit-ad-post", "why": "promoted posts" },
    { "selector": "span.badge", "hasText": "^Sponsored$", "upward": "article", "why": "native ads in the feed" },
    { "selector": "a", "matchesAttr": { "name": "href", "pattern": "^https://ads\\." }, "why": "ad links" }
  ],
  "block": [
    { "urlFilter": "||ads.example^", "types": ["script", "image", "xmlhttprequest"], "why": "ad requests" }
  ]
}
```

- `selector`: CSS (`:has()`, `:is()`, `:not()`, attributes). It runs in
  the page and inside every open shadow root.
- `hasText`: a regular expression on the text a person sees of the
  match (letters hidden among it don't count). No flags: `(?i:...)` for
  a part that ignores case. No repeated group that repeats inside.
- `upward`: from the match to what holds it, by a count of levels or a
  selector for the nearest holder that matches. Name the label, hide
  its card.
- `matchesAttr`: a regular expression on one attribute's value.
- `block`: requests to stop, held to the site's own pages. Never the
  site's own host whole; name a host of an ad network, or a path.
- `why`: a few words, for the person.

Prefer what's stable: words the site shows ("Sponsored"), roles and
`data-` attributes, element names of components. Class names that look
generated (`css-1x2y3z`, `_a3f9`) change with each release of the site.

Nothing may hide the page itself: a rule that matches `html`, `body`,
`main`, or something that holds the page's main content is refused or
does nothing.

## Trying, then presenting

1. `site.find` and `site.query` to see what's there.
2. Write the filter, `site.try` it, and look at each rule's matches,
   samples and `hiddenShare` (how much of each page's text it hides).
3. When it hides what it should on every page, and nothing else, call
   `present_filter`. It checks the filter again: it has to hide
   something, and never more than half a page's text. On a pass the
   person previews it on the live site and accepts or rejects it. Then
   stop, saying in a line what it hides.

If the person rejected one with a reason, or submitted another page to
extend it, start from `filters/<site>.json` as it is, keep what works,
and change only what the reason or the new page asks.
