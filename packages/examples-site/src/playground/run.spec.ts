import ts from "typescript";
import { describe, expect, it } from "vitest";

import { playgroundLibs } from "./libs.js";
import {
  COMPILER_OPTIONS,
  fromPlaygroundOptions,
  runPlayground,
  typesFromJson,
} from "./run.js";
import { STARTERS } from "./starters.js";

const libs = playgroundLibs();

function errorCount(code: string): number {
  const files = new Map(libs).set("/playground.ts", code);
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(COMPILER_OPTIONS),
    fileExists: (file) => files.has(file),
    readFile: (file) => files.get(file),
    getDefaultLibFileName: () => "/lib.es2022.d.ts",
    getDefaultLibLocation: () => "/",
    getSourceFile: (file, version) => {
      const text = files.get(file);
      return text === undefined
        ? undefined
        : ts.createSourceFile(file, text, version);
    },
  };
  const program = ts.createProgram(["/playground.ts"], COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program).length;
}

describe("errorCount", () => {
  it("counts the errors in the code and none from the libs", () => {
    expect(errorCount("const a: string[] = [];\n")).toBe(0);
    expect(errorCount("const a: string[] = [1];\n")).toBe(1);
  });
});

describe("runPlayground", () => {
  it("writes the observed types into the code it ran", async () => {
    const result = await runPlayground(
      `function label(user) {
  return user.name.toUpperCase();
}
label({ name: "Ada" });
`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain(
      "function label(user: { name: string }): string {",
    );
    expect(result.html).toContain("<ins>");
    expect(result.summary[0]).toBe("apply: 2 annotations written in 1 file.");
  });

  it("reports an annotation the type-check kept out, under the file's short name", async () => {
    const result = await runPlayground(
      `const pick = (items, key) => items.map((item) => item[key]);
pick([{ sku: "a", price: 2 }], "sku");
`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    const report = result.report.join("\n");
    expect(report).toContain("Would add a type error");
    expect(report).toContain("    playground.ts:1:");
    expect(report).not.toContain("/playground.ts");
  });

  it("runs code that exports what it declares", async () => {
    const result = await runPlayground(
      `export function double(n) {\n  return n * 2;\n}\ndouble(2);\n`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain("export function double(n: number) {");
  });

  it("answers with the error when the code throws", async () => {
    const result = await runPlayground(
      `function fail() {\n  throw new Error("boom");\n}\nfail();\n`,
      libs,
    );
    expect(result).toEqual({ ok: false, error: "Error: boom" });
  });

  it("says so when nothing ran, instead of an empty result", async () => {
    const result = await runPlayground(
      `function unused(x) {\n  return x;\n}\n`,
      libs,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toBe(`function unused(x) {\n  return x;\n}\n`);
    expect(result.summary).toEqual([
      "Nothing was observed. Call your functions at the end of the file: the calls are what ts-capture learns from.",
    ]);
  });

  it("applies what one version of the code showed to another", async () => {
    const ran =
      'function greet(user) {\n  return user.name;\n}\ngreet({ name: "Ada" });\n';
    const edited = `// a line added after the run\n${ran}`;
    const result = await runPlayground(ran, libs, { applyTo: edited });
    if (!result.ok) throw new Error(result.error);
    // The observation points where `user` was, which is now inside the comment.
    expect(result.after).toBe(edited);
    expect(result.skips.map((skip) => skip.reason)).toContain("no-site");
  });

  it("says which rule wrote each type", async () => {
    const code =
      'function greet(user) {\n  return user.name;\n}\ngreet({ name: "Ada" });\n';
    const result = await runPlayground(code, libs);
    if (!result.ok) throw new Error(result.error);
    expect(result.written).toContainEqual(
      expect.objectContaining({
        name: "user",
        rule: "written",
        type: "{ name: string }",
      }),
    );
  });

  it("applies with the options it is given over the defaults", async () => {
    const code =
      "function findUser(id: number) {\n  if (id < 0) return null;\n  return { id };\n}\nfindUser(1);\n";
    const result = await runPlayground(code, libs, {
      infer: { skipRedundantAnnotations: false },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain(
      "function findUser(id: number): { id: number } | null {",
    );
  });

  it("observes an implicit this when asked to", async () => {
    const code =
      'function describe() {\n  return this.name;\n}\ndescribe.call({ name: "Ada" });\n';
    const plain = await runPlayground(code, libs);
    const withThis = await runPlayground(code, libs, { implicitThis: true });
    if (!plain.ok || !withThis.ok) throw new Error("did not run");
    expect(plain.after).not.toContain("this: ");
    expect(withThis.after).toContain("describe(this: { name: string })");
  });

  it("names a shape it writes more than once, when asked", async () => {
    const code = `function city(address) {
  return address.city;
}

function ship(order) {
  return city(order.address);
}

ship({ id: 1, address: { city: "Oslo", zip: "0150" } });
`;
    const named = await runPlayground(code, libs, {
      infer: { aliasRepeatedShapes: true },
    });
    const plain = await runPlayground(code, libs);
    if (!named.ok || !plain.ok) throw new Error("did not run");
    expect(named.after).toContain(
      "type Address = { city: string; zip: string };",
    );
    expect(named.after).toContain("function city(address: Address)");
    expect(plain.after).not.toContain("type Address");
  });

  it("opens with an API response typed as named shapes, the case the playground leads with", async () => {
    const first = STARTERS[0]!;
    expect(first.options).toEqual({ aliasRepeatedShapes: true });
    const result = await runPlayground(first.code, libs, {
      infer: first.options,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toMatch(/^type Customer = /m);
    expect(result.after).toContain("function shipTo(customer: Customer)");
  });

  it.each(STARTERS.filter((starter) => starter.kind !== "json"))(
    "annotates the starter $title without adding a type error",
    async (starter) => {
      const result = await runPlayground(starter.code, libs, {
        infer: starter.options,
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.after).not.toBe(starter.code);
      expect(errorCount(result.after)).toBeLessThanOrEqual(
        errorCount(starter.code),
      );
    },
  );
});

describe("typesFromJson", () => {
  it("declares the type apply would write for the parsed value", () => {
    const result = typesFromJson(
      '{"id":7,"lines":[{"sku":"A1","qty":2},{"sku":"B2","qty":1,"note":"gift"}]}',
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toBe(
      [
        "type Data = {",
        "  id: number;",
        "  lines: {",
        "    note?: string;",
        "    qty: number;",
        "    sku: string;",
        "  }[];",
        "};",
        "",
      ].join("\n"),
    );
    expect(result.html).toContain("<ins>");
  });

  it("declares the shapes the value repeats when they are to be named", () => {
    const result = typesFromJson(
      '{"from":{"city":"Oslo","zip":"0150"},"to":{"city":"Bergen","zip":"5003"}}',
      { infer: { aliasRepeatedShapes: true } },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toBe(
      [
        "type Data = {",
        "  from: From;",
        "  to: From;",
        "};",
        "type From = {",
        "  city: string;",
        "  zip: string;",
        "};",
        "",
      ].join("\n"),
    );
  });

  it("names the type after the name given, and the shapes after it as apply would", () => {
    const result = typesFromJson(
      '{"lines":[{"sku":"A1","qty":2}],"returns":[{"sku":"B2","qty":1}]}',
      { name: "order", infer: { aliasRepeatedShapes: true } },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toMatch(/^type Order = \{\n {2}lines: Line\[\];/);
  });

  it("names the type Data when the name given is not a name", () => {
    for (const name of ["", "2nd", "my order"]) {
      const result = typesFromJson('{"id":1}', { name });
      if (!result.ok) throw new Error(result.error);
      expect(result.after).toMatch(/^type Data = /);
    }
  });

  it("names the root as core does, and never the same as a shape it declares", () => {
    const address = (city: string) =>
      `{"city":"${city}","street":"x","zip":"0"}`;
    const json = `{"billing":${address("a")},"shipping":${address("b")}}`;
    const result = typesFromJson(json, {
      name: "billing",
      infer: { aliasRepeatedShapes: true },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.after.match(/^type (\w+) /gm)).toEqual(
      expect.arrayContaining(["type Billing "]),
    );
    expect(new Set(result.after.match(/^type \w+/gm)).size).toBe(
      result.after.match(/^type \w+/gm)!.length,
    );

    const underscored = typesFromJson('{"id":1}', { name: "_order" });
    if (!underscored.ok) throw new Error(underscored.error);
    expect(underscored.after).toMatch(/^type Order = /);
  });

  it("reads as deep as asked", () => {
    const json =
      '{"data":{"repository":{"issues":{"nodes":[{"author":{"login":"ada"}}]}}}}';
    const shallow = typesFromJson(json);
    const deep = typesFromJson(json, { maxDepth: 8 });
    if (!shallow.ok || !deep.ok) throw new Error("did not run");
    expect(shallow.after).toBe("");
    expect(deep.after).toContain("login: string;");
  });

  it("says why when the value gives nothing to write", () => {
    const result = typesFromJson('{"tags":[]}');
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toBe("");
    expect(result.summary.join(" ")).toMatch(/empty list/);
    expect(result.summary.join(" ")).toMatch(/Depth/);
  });

  it("reports text that is not JSON", () => {
    const result = typesFromJson("{ id: 7 }");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/);
  });

  it.each(STARTERS.filter((starter) => starter.kind === "json"))(
    "types the JSON starter $title with types that compile",
    (starter) => {
      const result = typesFromJson(starter.code, { infer: starter.options });
      if (!result.ok) throw new Error(result.error);
      expect(result.after).toMatch(/^type Data = /);
      expect(errorCount(result.after)).toBe(0);
    },
  );
});

describe("fromPlaygroundOptions", () => {
  it("keeps string literals both where values are observed and where the type is made", () => {
    const { infer, literalOptions } = fromPlaygroundOptions({
      "literal.string": true,
      aliasRepeatedShapes: true,
    });
    expect(infer.literal?.string).toBe(true);
    expect(infer.literal?.number).toBe(false);
    expect(infer.aliasRepeatedShapes).toBe(true);
    expect(literalOptions.literalString).toBe(true);
    expect(Object.keys(infer)).not.toContain("literal.string");
  });

  it("observes and types without literals by default", () => {
    const { infer, literalOptions } = fromPlaygroundOptions({});
    expect(infer.literal?.string ?? false).toBe(false);
    expect(literalOptions.literalString ?? false).toBe(false);
  });
});

describe("string literals in the playground", () => {
  const json =
    '{"shapes":[{"kind":"circle","r":1},{"kind":"square","s":2}],"status":"paid"}';

  it("tell objects apart by a literal field in JSON, and make a lone string a literal", () => {
    const result = typesFromJson(
      json,
      fromPlaygroundOptions({ "literal.string": true }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain('kind: "circle";');
    expect(result.after).toContain('status: "paid";');
  });

  it("merge the objects into one shape without them", () => {
    const result = typesFromJson(json, fromPlaygroundOptions({}));
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain("kind: string;");
    expect(result.after).toContain("r?: number;");
  });

  it("are kept in code that is run", async () => {
    const result = await runPlayground(
      'function draw(shape) {\n  return shape.kind;\n}\ndraw({ kind: "circle" });\n',
      libs,
      fromPlaygroundOptions({ "literal.string": true }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.after).toContain('shape: { kind: "circle" }');
  });
});
