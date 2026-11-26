# Debugging a web app in the browser

The browser keeps a console log, the page's uncaught errors and every request it made, across
navigations, for each tab. You and the developer read the same ones (the Bug button in the
browser's toolbar). Debug from evidence, in this order.

## 1. Reproduce it

Open the app (usually `http://localhost:PORT`; start the dev server first if it is not running)
in a tab of yours. Do exactly what triggers the problem with `browser_act`. Note the steps: they
are the bug report.

## 2. Read what the page already says

- `browser_console` with `level: "error"`: exceptions with their stack, unhandled promise
  rejections, resources that failed to load, requests blocked by the content policy. Each line
  has a number; pass the last as `since` to read only what the next action produced.
- `browser_network` with `status: "failed"`: 4xx, 5xx and requests that never answered. `get` one:
  look at what was sent (a wrong body, a missing header), at what came back (the server's own error
  message is often there), and at the initiator, which points at the line that made the call.
- A request still `pending` after an action is a hang. A request made twice is a duplicate effect.

## 3. Look closer

- `browser_inspect` `what: "element"`: where it is, its computed styles and attributes, what
  covers it. Use it for "the button does nothing" (disabled? covered? zero size?) and layout bugs.
- `browser_eval` reads state a snapshot cannot: a store, a variable, a computed value, the result
  of calling a function of the page. It can be an `await` expression. Reading is fine; do not use it
  to change state to make a bug disappear.
- `browser_inspect` `what: "storage"`, `"cookies"`: stale tokens, a flag in localStorage, a
  cookie missing its `SameSite` or `Secure`. Values that look like credentials are hidden unless you
  pass `reveal_secrets`.
- `browser_inspect` `what: "performance"`: timings, size, the slowest resources, node counts.
- `browser_screenshot` for how it looks, before and after.

## 4. Fix and prove it

Change the code, reload (`browser_tabs` `reload`), repeat the steps, and show that the console and
the network are clean for them. A fix is not done until the same steps that failed now pass.

## Reporting

Give the cause (the line, the request, the value), the steps, what you changed, and the evidence
after. If you could not reproduce it, say what you tried and what the logs showed.
