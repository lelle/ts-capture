// rule: written
// site: data
// title: What the value turned out to be
// verdict: ok
// `JSON.parse` returns `any`, so TypeScript knows nothing about `data`. The run
// saw the object it held.

const data = JSON.parse('{"id": 1, "name": "Ada"}');

data.name;
