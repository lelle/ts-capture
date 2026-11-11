import { describe, expect, it } from "vitest";

import type { CollectorOptions } from "./collector-contract.js";

import { type DeepPartial, type InferOptions, resolveInferOptions } from "./configuration.js";
import { run } from "./test-utils/playground-run.js";
import { typesFromValues } from "./types-from-values.js";

// typesFromValues gives what apply writes for a parameter called with the
// same values, so each case runs both and compares them.

interface Case {
  title: string;
  /** Each a JavaScript expression; one call per value. */
  values: string[];
  infer?: DeepPartial<InferOptions>;
  /** What is observed: set for apply's run and passed to typesFromValues alike. */
  collector?: CollectorOptions;
}

const CASES: Case[] = [
  { title: "one object", values: ['{ name: "Ada", age: 36 }'] },
  { title: "a field only some values have", values: ['{ id: 1, name: "Ada" }', "{ id: 2 }"] },
  { title: "primitives that differ", values: ["1", '"one"'] },
  {
    title: "a list of objects inside an object",
    values: ['{ id: 7, lines: [{ sku: "A1", qty: 2 }, { sku: "B2", qty: 1, note: "gift" }] }'],
  },
  {
    title: "lists that differ between values",
    values: ['[{ sku: "A1", qty: 2 }]', '[{ sku: "B2", qty: 1, note: "gift" }]'],
  },
  { title: "built-in objects", values: ['{ at: new Date(0), seen: new Set(["a"]) }'] },
  {
    title: "a repeated shape, named",
    values: [
      '{ from: { city: "Oslo", zip: "0150" }, to: { city: "Bergen", zip: "5003" } }',
      '{ from: { city: "Molde", zip: "6413" }, to: { city: "Ålesund", zip: "6002" } }',
    ],
    infer: { aliasRepeatedShapes: true },
  },
  {
    title: "a value deeper than observation reads by default",
    values: ["{ a: { b: { c: { d: { e: { f: 1 } } } } } }"],
    collector: { maxDepth: 8 },
  },
  {
    title: "string literals kept",
    values: ['{ kind: "circle", r: 1 }', '{ kind: "square", s: 2 }'],
    collector: { literalOptions: { literalString: true } },
    infer: { literal: { string: true } },
  },
];

const NAME = "trip";

async function whatApplyWrites(
  values: string[],
  infer: DeepPartial<InferOptions> = {},
  collector: CollectorOptions = {},
): Promise<{ type: string | undefined; declarations: string[] }> {
  const source = [
    `function f(${NAME}) {`,
    `  void ${NAME};`,
    `}`,
    ...values.map((value) => `f(${value});`),
  ].join("\n");
  const { after, decided } = await run(source, source, {
    infer: resolveInferOptions({ infer }),
    collector,
  });
  const written = decided.find((d) => d.name === NAME && d.outcome === "written");
  const declarations = after.split("\n").filter((line) => line.startsWith("type "));
  return { type: written?.type, declarations };
}

const evaluate = (expression: string): unknown => new Function(`return (${expression});`)();

describe("typesFromValues gives what apply writes for a parameter given the same values", () => {
  it.each(CASES.map((c) => [c.title, c] as const))(
    "%s",
    async (_, { values, infer, collector }) => {
      const applied = await whatApplyWrites(values, infer, collector);
      expect(applied.type, "apply wrote the parameter").toBeDefined();

      const result = typesFromValues(values.map(evaluate), {
        name: NAME,
        infer,
        maxDepth: collector?.maxDepth,
        literalOptions: collector?.literalOptions,
      });

      expect({ type: result.type, declarations: result.declarations }).toEqual(applied);
    },
  );
});

describe("typesFromValues", () => {
  it("declares nothing when aliasRepeatedShapes is off, as apply does by default", () => {
    const shape = { city: "Oslo", zip: "0150" };
    const result = typesFromValues([{ from: shape, to: shape }]);

    expect(result.declarations).toEqual([]);
    expect(result.type).toBe(
      "{ from: { city: string; zip: string }; to: { city: string; zip: string } }",
    );
  });

  it("declares a shape the values repeat when aliasRepeatedShapes is on", () => {
    const result = typesFromValues(
      [{ from: { city: "Oslo", zip: "0150" }, to: { city: "Bergen", zip: "5003" } }],
      { infer: { aliasRepeatedShapes: true } },
    );

    expect(result.declarations).toEqual(["type From = { city: string; zip: string };"]);
    expect(result.type).toBe("{ from: From; to: From }");
  });

  it("gives no type for values that say nothing about themselves", () => {
    expect(typesFromValues([]).type).toBeUndefined();
    expect(typesFromValues([{ tags: [] }]).type).toBeUndefined();
  });

  it("gives no type for an object deeper than observation reaches", () => {
    expect(typesFromValues([{ a: { b: { c: { d: 1 } } } }]).type).toBe(
      "{ a: { b: { c: { d: number } } } }",
    );
    expect(typesFromValues([{ a: { b: { c: { d: { e: { f: 1 } } } } } }]).type).toBeUndefined();
  });

  it("reaches as deep as maxDepth asks", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };

    expect(typesFromValues([deep], { maxDepth: 7 }).type).toBe(
      "{ a: { b: { c: { d: { e: { f: number } } } } } }",
    );
    expect(typesFromValues([deep], { maxDepth: 6 }).type).toBeUndefined();
  });

  it("names the root as it names shapes, and names no shape the same", () => {
    const address = (city: string) => ({ city, street: "x", zip: "0" });
    const result = typesFromValues([{ billing: address("a"), shipping: address("b") }], {
      name: "billing",
      infer: { aliasRepeatedShapes: true },
    });

    expect(result.rootName).toBe("Billing");
    expect(result.declarations.join("\n")).not.toMatch(/^type Billing /m);
    expect(result.type).toMatch(/billing: (\w+); shipping: \1/);
  });

  it("has no root name for a name that is not an identifier, and strips leading _ and $", () => {
    expect(typesFromValues([{ a: 1 }], { name: "2nd" }).rootName).toBeUndefined();
    expect(typesFromValues([{ a: 1 }]).rootName).toBeUndefined();
    expect(typesFromValues([{ a: 1 }], { name: "_order" }).rootName).toBe("Order");
  });

  it("observes string literals when infer keeps them, unless literalOptions says otherwise", () => {
    const keep = { infer: { literal: { string: true } } };
    expect(typesFromValues([{ k: "a" }], keep).type).toBe('{ k: "a" }');
    expect(
      typesFromValues([{ k: "a" }], { ...keep, literalOptions: { literalString: false } }).type,
    ).toBe("{ k: string }");
  });
});
