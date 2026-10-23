// rule: gate.polymorphic-this
// site: return type
// verdict: ok
// TypeScript infers `this`; writing `Builder` would cost every subclass its own type.
class Builder {
  parts: string[] = [];
  add(part: string) {
    this.parts.push(part);
    return this;
  }
}

new Builder().add("a");
