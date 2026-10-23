// rule: info.out-of-scope
// site: made
// title: A variable holding a class local to a callback
// verdict: ok
// The value was an instance of a class declared inside the callback. Its name
// means nothing where `made` is declared.

function build(factory) {
  const made = factory();
  return made;
}

build(() => {
  class Box {
    size = 1;
  }
  return new Box();
});
