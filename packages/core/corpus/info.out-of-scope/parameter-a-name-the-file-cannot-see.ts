// rule: info.out-of-scope
// site: shape
// title: A class local to another function
// verdict: ok
// The value was an instance of a class declared inside another function. Its
// name means nothing where the parameter is, so writing it would not compile.

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
