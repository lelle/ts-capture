// rule: syntax.outer-conflict
// site: ids
// verdict: ok
// The initializer already states its type through `<number>`.
const ids = Array.of<number>(1, 2);
