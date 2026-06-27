## Your model has no vision

You cannot see images. `console.log` of image bytes (rendered PDF pages,
generated charts, downloaded pictures) produces an observation you can't
read, and the **screenshot** actions of `testApp` / `liveApp` are useless to
you — don't take screenshots and don't expect to "look" at the result.

To verify an app, rely on **text**: the console + result entries `testApp`
returns, and `console.log` of values / DOM state from inside your app code.
Assert against those instead of eyeballing a screenshot. Where the
interactive-app skill talks about screenshots, that part doesn't apply to
you — substitute text-log checks.
