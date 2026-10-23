// rule: info.out-of-scope
// site: shape
// verdict: ok
// `Circle` is declared inside another function, so its name means nothing here.
function makeShape() {
  class Circle {
    radius = 1;
  }
  return new Circle();
}

function area(shape) {
  return Math.PI * shape.radius ** 2;
}

area(makeShape());
