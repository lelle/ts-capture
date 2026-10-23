// rule: info.out-of-scope
// site: made
// title: A field holding a class local to a callback
// verdict: ok
// The field held an instance of a class declared inside a callback. Its name
// means nothing in `Holder`.

function build(factory) {
  return factory();
}

class Holder {
  made = build(() => {
    class Box {
      size = 1;
    }
    return new Box();
  });
}

new Holder();
