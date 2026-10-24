// rule: written
// site: { size }
// title: A destructuring, named by its pattern
// verdict: ok
// The parsed value has no type TypeScript knows, so the pattern takes the shape
// the run saw. The report names the site by its pattern, `{ size }`.

const { size } = JSON.parse('{ "size": 3 }');
console.log(size);
