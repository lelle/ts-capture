// rule: syntax.array-callback-shape
// site: point
// title: An array's callback, typed by the array
// verdict: ok
// The callback's parameter is typed by the array it is called on. Writing the
// element's shape again at the callback adds a long type and nothing else.

const xs = [{ x: 1 }, { x: 2 }].map((point) => point.x);
