// rule: syntax.outer-conflict
// site: ids
// title: The call already names its type
// verdict: ok
// The initializer passes `<number>`, which says what the variable is. Writing
// the type again would only repeat it, or contradict it.

const ids = Array.of<number>(1, 2);
