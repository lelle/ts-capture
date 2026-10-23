// rule: syntax.ignored
// site: settings
// title: Asked to stay out
// verdict: ok
// A `@ts-capture-ignore` comment above a declaration keeps apply away from all
// of it.

// @ts-capture-ignore
const settings = JSON.parse('{"dark": true}');
