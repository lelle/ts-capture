// rule: syntax.as-cast
// site: port
// verdict: ok
// The author cast the value; apply defers to the cast.
const port = JSON.parse("3000") as number;
