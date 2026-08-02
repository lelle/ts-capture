// Untyped helpers — what @ts-capture/vite should annotate after a vitest run.

export function add(a, b) {
  return a + b;
}

export function greet(name) {
  return `Hello, ${name}!`;
}

export function isAdult(person) {
  return person.age >= 18;
}
