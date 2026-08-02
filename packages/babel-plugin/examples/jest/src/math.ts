// Untyped helpers — what @ts-capture/babel-plugin should annotate after a test run.

export function add(a, b) {
  return a + b;
}

export function greet(name) {
  return `Hello, ${name}!`;
}

export function isAdult(person) {
  return person.age >= 18;
}
