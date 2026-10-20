import type { ApplySkipReason } from "@ts-capture/core/browser";

// One cell per thing apply does to a position, or refuses to do and why. Each
// cell with `code` is checked by cells.spec.ts and rendered by running that
// same code, so what the page says is what the applier does.

export type SiteKind = "parameter";

export type Outcome = "written" | ApplySkipReason;

export interface Cell {
  kind: SiteKind;
  outcome: Outcome;
  /** The position the cell is about: the parameter's name. */
  name: string;
  title: string;
  /** Why apply does this, in the reader's terms. */
  why: string;
  /** Where in `packages/core/src` it is decided. */
  decidedBy: { file: string; symbol: string };
  /** A file that, run and applied, ends in `outcome` at `name`. */
  code?: string;
  /** Why ordinary code cannot reach this cell, when it cannot. */
  unreachable?: string;
  /** Examples from real runs (`docs/examples/examples.json` ids) in this cell. */
  real?: string[];
}

export const OUTCOMES: Outcome[] = [
  "written",
  "type-error",
  "no-information",
  "out-of-scope",
  "contradiction",
  "redundant",
  "kept-existing",
  "already-annotated",
  "ignored",
  "left-to-typescript",
  "no-site",
];

export const CELLS: Cell[] = [
  {
    kind: "parameter",
    outcome: "written",
    name: "user",
    title: "What every call passed",
    why: "The run saw one shape at this parameter, and nothing in TypeScript already says more.",
    decidedBy: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
    code: `function greet(user) {
  return "Hello " + user.name;
}

greet({ name: "Ada" });
greet({ name: "Bo" });
`,
    real: ["params-and-return", "callback", "untyped-collection", "named-type"],
  },
  {
    kind: "parameter",
    outcome: "type-error",
    name: "settings",
    title: "A type the code would not compile with",
    why: "The run saw `{ name: string }`, but the function adds a field. Written, that type would make the next line an error, so apply type-checks every annotation first and drops this one.",
    decidedBy: {
      file: "apply-types-verify.ts",
      symbol: "filterAcceptedReplacements",
    },
    code: `function enable(settings) {
  settings.enabled = true;
  return settings;
}

enable({ name: "dark mode" });
`,
    real: ["left-alone"],
  },
  {
    kind: "parameter",
    outcome: "no-information",
    name: "options",
    title: "Nothing worth writing",
    why: "No call passed this parameter, so all the run saw was `undefined`. That says nothing about what the parameter is for, and written as `options: undefined` it would make every call that does pass options an error.",
    decidedBy: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
    code: `function connect(options) {
  return { retries: 3, ...options };
}

connect();
`,
  },
  {
    kind: "parameter",
    outcome: "out-of-scope",
    name: "shape",
    title: "A name the file cannot see",
    why: "The value was an instance of a class declared inside another function. Its name means nothing where the parameter is, so writing it would not compile.",
    decidedBy: { file: "scope-reachability.ts", symbol: "allTypeRefsInScope" },
    code: `function makeShape() {
  class Circle {
    radius = 1;
  }
  return new Circle();
}

function area(shape) {
  return Math.PI * shape.radius ** 2;
}

area(makeShape());
`,
  },
  {
    kind: "parameter",
    outcome: "contradiction",
    name: "word",
    title: "The run disagrees with TypeScript",
    why: "TypeScript already types this callback parameter as `string`, but the run passed `undefined` too. Apply does not write a type the checker contradicts; it reports the disagreement instead.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "observedBeyondInferred",
    },
    code: `function each(words: string[], visit: (value: string) => void) {
  for (const word of words) visit(word);
}

const words = ["a", "b"];
words.push(undefined as unknown as string);
each(words, (word) => word);
`,
  },
  {
    kind: "parameter",
    outcome: "redundant",
    name: "word",
    title: "TypeScript already knows",
    why: "A callback's parameter is typed by where the callback is passed. Writing the same type again adds nothing.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "isRedundantAnnotation",
    },
    code: `const lengths = ["a", "bb"].map((word) => word.length);
`,
  },
  {
    kind: "parameter",
    outcome: "kept-existing",
    name: "mode",
    title: "A name would be replaced by what it is made of",
    why: "TypeScript types this parameter as the enum `Mode`. The run only sees the string underneath. Writing `string` would throw the enum away, and with it every comparison against `Mode.Fast`.",
    decidedBy: { file: "redundant-annotation.ts", symbol: "erasesEnum" },
    code: `enum Mode {
  Fast = "fast",
  Slow = "slow",
}

const modes = [Mode.Fast, Mode.Slow];
modes.forEach((mode) => mode.length);
`,
  },
  {
    kind: "parameter",
    outcome: "already-annotated",
    name: "",
    title: "A type is written already",
    why: "Apply never replaces a type someone wrote.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "A parameter with a type is not observed in a normal run, so there is nothing to skip. It happens when the same observations are applied twice, or with `TS_CAPTURE_OBSERVE_ANNOTATED`.",
  },
  {
    kind: "parameter",
    outcome: "ignored",
    name: "input",
    title: "Asked to stay out",
    why: "A `@ts-capture-ignore` comment above a declaration keeps apply away from all of it.",
    decidedBy: { file: "cst-site-index.ts", symbol: "buildCstSiteIndex" },
    code: `// @ts-capture-ignore
function parse(input) {
  return JSON.parse(input);
}

parse('{"a":1}');
`,
  },
  {
    kind: "parameter",
    outcome: "no-site",
    name: "",
    title: "The code moved",
    why: "The observation points at a position where there is no parameter any more, because the file changed after the run.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "Only stale observations end here: the file changed between the run and apply.",
  },
];
