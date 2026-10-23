// rule: syntax.array-callback-shape
// site: point
// verdict: ok
// The array's element type already types the callback; the shape would be noise.
const xs = [{ x: 1 }, { x: 2 }].map((point) => point.x);
