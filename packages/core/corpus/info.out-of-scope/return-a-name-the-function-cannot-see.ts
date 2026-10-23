// rule: info.out-of-scope
// site: return type
// title: A name the function cannot see
// verdict: ok
// What came back was an instance of a class declared inside the callback. Its
// name means nothing at `build`, so writing it would not compile.

function build(factory) {
  return factory();
}

build(() => {
  class Box {
    size = 1;
  }
  return new Box();
});
