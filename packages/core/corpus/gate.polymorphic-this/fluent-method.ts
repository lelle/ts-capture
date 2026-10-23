// rule: gate.polymorphic-this
// site: return type
// title: A method that returns `this`
// verdict: ok
// TypeScript types the return as `this`, which in a subclass is the subclass.
// The run saw a `Builder`. Writing `Builder` would make every subclass's
// chained calls return the base class.

class Builder {
  parts: string[] = [];
  add(part: string) {
    this.parts.push(part);
    return this;
  }
}

new Builder().add("a");
