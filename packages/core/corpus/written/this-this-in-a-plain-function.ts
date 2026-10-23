// rule: written
// site: this
// title: `this` in a plain function
// apply: implicit-this
// verdict: ok
// A function that reads `this` without being a method has an implicit `any`
// this. With the instrumenter asked to look for it, the run sees what `this`
// was and apply writes it as the first parameter.

function describe() {
  return this.name;
}

describe.call({ name: "Ada" });
