// rule: syntax.as-cast
// site: port
// title: `JSON.parse` cast `as number`
// verdict: ok
// The initializer says `as number`. The cast is what the author asked for, so
// apply writes nothing over it, whatever the run saw.

const port = JSON.parse("3000") as number;
