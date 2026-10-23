// rule: syntax.ignored
// site: handler
// title: Asked to stay out
// verdict: ok
// A `@ts-capture-ignore` comment above a declaration keeps apply away from all
// of it.

// @ts-capture-ignore
function on(handler) {
  return handler();
}

on(() => 1);
