import { add, greet, isAdult } from "../src/math";

test("add", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-1, 1)).toBe(0);
});

test("greet", () => {
  expect(greet("Ada")).toBe("Hello, Ada!");
});

test("isAdult", () => {
  expect(isAdult({ name: "Bob", age: 30 })).toBe(true);
  expect(isAdult({ name: "Cara", age: 12 })).toBe(false);
});
