// rule: verify.type-error
// site: data
// title: A field a method sets to `null`
// verdict: ok
// The run saw `{ a: number }`, but `reset` sets the field to `null`. Written,
// the type would make that line an error, so apply drops it.

class Store {
  data = JSON.parse('{"a": 1}');
  reset() {
    this.data = null;
  }
}

new Store();
