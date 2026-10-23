// rule: written
// site: items
// title: What the field turned out to hold
// verdict: ok
// `JSON.parse` returns `any`, so TypeScript knows nothing about `items`. The
// run saw the array it held.

class Store {
  items = JSON.parse("[1, 2]");
}

new Store();
