# Automating through the page's own HTTP calls

Most pages are a front for a few HTTP calls. Driving the page (clicking, scrolling, waiting)
is slow, breaks when the layout changes, and gets only what is on screen. The call behind a screen
usually returns all of it, as JSON, in milliseconds, and can be repeated from a script. So when the
job is to get data out of a site or to do something repeatedly, find the call first.

Do it only for sites and data the developer is entitled to use, and respect what the site asks
(terms, rate limits, robots). If a call needs the developer's own login, say so and ask before
using their session.

## Find the call

1. Open the page in a tab of yours and `browser_network` with `action: "clear"`.
2. Do the one thing that shows the data (open the list, press "next page", search) with
   `browser_act`.
3. `browser_network` (default list) shows the page's own calls: fetch, XHR, WebSocket. Files it
   loaded (images, scripts, styles) are left out unless `all: true`. Narrow with `text`, `method`,
   `status`, `mime: "json"`.
4. If the screen shows a value you can name (an order number, a price), `action: "search"` with
   that `text` finds the call whose response contains it. This is the fastest way to the right
   request.
5. `action: "get"` with its id shows the request and the response in full, with the **shape** of
   the JSON (`{ orders: [{ id: number, ... } × 20], next: string }`), which tells you the fields
   without reading all of it. Look for the page parameter, the cursor, the filters.

## Repeat it

- `action: "curl"` or `"fetch"` gives a command for that request. Credentials are left out as
  `${AUTHORIZATION}`-style placeholders: put them in from the environment, never into the file.
- Try it once from the shell (`curl ... | jq`). If it answers like the page did, build the script
  around it: loop the page or cursor parameter until the list ends, back off on 429, stop on
  errors, write the result to a file.
- Compare one result with what the page shows. A script that returns something plausible but
  different (another locale, missing a filter the page applies) is worse than no script.
- GraphQL: the URL is one endpoint and the query is in the request body; `get` shows it, with its
  variables. Change the variables, not the query.
- A WebSocket entry lists its first frames: what the page sends to subscribe and what it gets.

## When to drive the page instead

When the call is signed per request (a header computed by the page's script), needs a token that
only a real login produces, is guarded by a bot check, or the task is to test the page itself.
Then do it with `browser_act`, and still use `browser_network` to confirm what it sent.

## What to hand over

The script, how to run it, the request it replays, what it needs (an environment variable, not the
value), and what you checked. If the site could change without notice, say what would break.
