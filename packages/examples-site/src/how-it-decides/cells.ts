import type { ApplySkipReason } from "@ts-capture/core/browser";

// One cell per thing apply does to a position, or refuses to do and why. Each
// cell with `code` is checked by cells.spec.ts and rendered by running that
// same code, so what the page says is what the applier does.

export type SiteKind = "parameter" | "return" | "variable";

export type Outcome = "written" | ApplySkipReason;

export interface Cell {
  kind: SiteKind;
  outcome: Outcome;
  /** The position the cell is about: the parameter's or variable's name, or `return type`. */
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
  {
    kind: "return",
    outcome: "written",
    name: "return type",
    title: "What came back, where TypeScript knows nothing",
    why: "The function hands back an element of a parameter TypeScript has no type for, so it infers `any`. The run saw what actually came back.",
    decidedBy: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
    code: `function first(list) {
  return list[0];
}

first([{ id: 1, name: "Ada" }]);
`,
    real: ["params-and-return"],
  },
  {
    kind: "return",
    outcome: "type-error",
    name: "return type",
    title: "A branch the tests never took",
    why: "Every call returned the object, so that is what the run saw. But the other branch returns `null`, and written, the type would make that line an error.",
    decidedBy: {
      file: "apply-types-verify.ts",
      symbol: "filterAcceptedReplacements",
    },
    code: `function find(id) {
  if (id > 0) return { id };
  return null;
}

find(1);
`,
  },
  {
    kind: "return",
    outcome: "no-information",
    name: "return type",
    title: "Nothing worth writing",
    why: "All that came back was an empty object, which says nothing about what the function returns.",
    decidedBy: {
      file: "compute-annotation.ts",
      symbol: "carriesNoInformation",
    },
    code: `function parse(text) {
  return JSON.parse(text);
}

parse("{}");
`,
  },
  {
    kind: "return",
    outcome: "out-of-scope",
    name: "return type",
    title: "A name the function cannot see",
    why: "What came back was an instance of a class declared inside the callback. Its name means nothing at `build`, so writing it would not compile.",
    decidedBy: { file: "scope-reachability.ts", symbol: "allTypeRefsInScope" },
    code: `function build(factory) {
  return factory();
}

build(() => {
  class Box {
    size = 1;
  }
  return new Box();
});
`,
  },
  {
    kind: "return",
    outcome: "contradiction",
    name: "return type",
    title: "The run disagrees with TypeScript",
    why: "TypeScript reads the return as `string` from the parameter's type. The run got `undefined`, because a test passed an object without the field. Apply reports that instead of writing either.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "observedBeyondInferred",
    },
    code: `function nameOf(user: { name: string }) {
  return user.name;
}

nameOf(JSON.parse("{}"));
`,
  },
  {
    kind: "return",
    outcome: "redundant",
    name: "return type",
    title: "TypeScript already knows",
    why: "TypeScript infers `number` from the body, which is what the run saw.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "isRedundantAnnotation",
    },
    code: `function double(n: number) {
  return n * 2;
}

double(2);
`,
  },
  {
    kind: "return",
    outcome: "kept-existing",
    name: "return type",
    title: "A name would be replaced by what it is made of",
    why: "TypeScript infers the enum `Mode`. The run only sees the string underneath, and writing `string` would throw the enum away.",
    decidedBy: { file: "redundant-annotation.ts", symbol: "erasesEnum" },
    code: `enum Mode {
  Fast = "fast",
  Slow = "slow",
}

function pick(quick) {
  return quick ? Mode.Fast : Mode.Slow;
}

pick(true);
`,
  },
  {
    kind: "return",
    outcome: "already-annotated",
    name: "",
    title: "A type is written already",
    why: "Apply never replaces a type someone wrote.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "A return with a type is not observed in a normal run, so there is nothing to skip. It happens when the same observations are applied twice, or with `TS_CAPTURE_OBSERVE_ANNOTATED`.",
  },
  {
    kind: "return",
    outcome: "ignored",
    name: "return type",
    title: "Asked to stay out",
    why: "A `@ts-capture-ignore` comment above a declaration keeps apply away from all of it.",
    decidedBy: { file: "cst-site-index.ts", symbol: "buildCstSiteIndex" },
    code: `// @ts-capture-ignore
function load(text) {
  return JSON.parse(text);
}

load('{"a":1}');
`,
  },
  {
    kind: "return",
    outcome: "no-site",
    name: "",
    title: "The code moved",
    why: "The observation points at a position where there is no function any more, because the file changed after the run.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "Only stale observations end here: the file changed between the run and apply.",
  },
  {
    kind: "variable",
    outcome: "written",
    name: "data",
    title: "What the value turned out to be",
    why: "`JSON.parse` returns `any`, so TypeScript knows nothing about `data`. The run saw the object it held.",
    decidedBy: { file: "cst-replacements.ts", symbol: "buildCstReplacements" },
    code: 'const data = JSON.parse(\'{"id": 1, "name": "Ada"}\');\n\ndata.name;\n',
  },
  {
    kind: "variable",
    outcome: "type-error",
    name: "current",
    title: "A later assignment would not compile",
    why: "The run saw `current` hold `{ n: number }`. Written, that type would make the assignment of `null` further down an error, so apply drops it.",
    decidedBy: {
      file: "apply-types-verify.ts",
      symbol: "filterAcceptedReplacements",
    },
    code: "let current = JSON.parse('{\"n\": 1}');\ncurrent = null;\n",
  },
  {
    kind: "variable",
    outcome: "no-information",
    name: "blank",
    title: "Nothing worth writing",
    why: "All the run saw was an empty object, which says nothing about what `blank` is for.",
    decidedBy: {
      file: "compute-annotation.ts",
      symbol: "carriesNoInformation",
    },
    code: 'const blank = JSON.parse("{}");\n',
  },
  {
    kind: "variable",
    outcome: "out-of-scope",
    name: "made",
    title: "A name the code cannot see",
    why: "The value was an instance of a class declared inside the callback. Its name means nothing where `made` is declared.",
    decidedBy: { file: "scope-reachability.ts", symbol: "allTypeRefsInScope" },
    code: "function build(factory) {\n  const made = factory();\n  return made;\n}\n\nbuild(() => {\n  class Box {\n    size = 1;\n  }\n  return new Box();\n});\n",
  },
  {
    kind: "variable",
    outcome: "contradiction",
    name: "word",
    title: "The run disagrees with TypeScript",
    why: "TypeScript types an element of a `string[]` as `string`. The loop read one past the end, so the run saw `undefined` too. Apply reports the disagreement instead of writing either.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "observedBeyondInferred",
    },
    code: `const words = ["a"];
for (const i of [0, 1]) {
  const word = words[i];
}
`,
  },
  {
    kind: "variable",
    outcome: "redundant",
    name: "largest",
    title: "TypeScript already knows",
    why: "TypeScript infers `number` from the call, which is what the run saw.",
    decidedBy: {
      file: "redundant-annotation.ts",
      symbol: "isRedundantAnnotation",
    },
    code: "const largest = Math.max(1, 2);\n",
  },
  {
    kind: "variable",
    outcome: "kept-existing",
    name: "mode",
    title: "A name would be replaced by what it is made of",
    why: "TypeScript infers the enum `Mode`. The run only sees the string underneath, and writing `string` would throw the enum away.",
    decidedBy: { file: "redundant-annotation.ts", symbol: "erasesEnum" },
    code: 'enum Mode {\n  Fast = "fast",\n  Slow = "slow",\n}\n\nconst mode = [Mode.Fast, Mode.Slow][0];\n',
  },
  {
    kind: "variable",
    outcome: "ignored",
    name: "settings",
    title: "Asked to stay out",
    why: "A `@ts-capture-ignore` comment above a declaration keeps apply away from all of it.",
    decidedBy: { file: "cst-site-index.ts", symbol: "buildCstSiteIndex" },
    code: "// @ts-capture-ignore\nconst settings = JSON.parse('{\"dark\": true}');\n",
  },
  {
    kind: "variable",
    outcome: "left-to-typescript",
    name: "label",
    title: "Only one branch was seen",
    why: "The initializer can give either side of `??`, and the run only ever saw one. Writing what it saw would forbid the other, so the type is left to TypeScript, which knows both.",
    decidedBy: {
      file: "annotation-eligibility.ts",
      symbol: "decideVarDeclSite",
    },
    code: 'const words = ["a", "b"];\nconst label = words.find((w) => w === "a") ?? "none";\n',
  },
  {
    kind: "variable",
    outcome: "already-annotated",
    name: "",
    title: "A type is written already",
    why: "Apply never replaces a type someone wrote.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "A variable with a type is not observed in a normal run, so there is nothing to skip. It happens when the same observations are applied twice, or with `TS_CAPTURE_OBSERVE_ANNOTATED`.",
  },
  {
    kind: "variable",
    outcome: "no-site",
    name: "",
    title: "The code moved",
    why: "The observation points at a position where there is no variable any more, because the file changed after the run.",
    decidedBy: { file: "cst-routing.ts", symbol: "routeEntries" },
    unreachable:
      "Only stale observations end here: the file changed between the run and apply.",
  },
];
