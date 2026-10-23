// rule: gate.redundant
// site: count
// title: TypeScript already knows, from the constructor
// verdict: ok
// Once the constructor's parameter has a type, TypeScript infers the field from
// the assignment in the constructor. Writing it again adds nothing.

class Counter {
  count;
  constructor(start) {
    this.count = start;
  }
}

new Counter(5);
