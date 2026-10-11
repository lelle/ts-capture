import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { reachableLibs } from "./libs.js";
import { COMPILER_OPTIONS } from "./run.js";

describe("reachableLibs", () => {
  it("keeps a lib file and the ones it references, and nothing else", () => {
    const all = new Map([
      [
        "/lib.a.d.ts",
        '/// <reference lib="b" />\n/// <reference lib="c.sub" />\ninterface A {}',
      ],
      ["/lib.b.d.ts", '/// <reference lib="c.sub" />\ninterface B {}'],
      ["/lib.c.sub.d.ts", "interface C {}"],
      ["/lib.dom.d.ts", "interface Window {}"],
    ]);
    expect([...reachableLibs(all, ["/lib.a.d.ts"]).keys()].sort()).toEqual([
      "/lib.a.d.ts",
      "/lib.b.d.ts",
      "/lib.c.sub.d.ts",
    ]);
  });

  it("names the file a reference points at when it is missing", () => {
    const all = new Map([["/lib.a.d.ts", '/// <reference lib="gone" />']]);
    expect(() => reachableLibs(all, ["/lib.a.d.ts"])).toThrow("/lib.gone.d.ts");
  });

  it("gives the playground's options a program without the DOM", () => {
    const all = createDefaultMapFromNodeModules(COMPILER_OPTIONS, ts);
    const libs = reachableLibs(all, ["/lib.es2022.d.ts"]);
    expect(libs.has("/lib.es5.d.ts")).toBe(true);
    expect(libs.has("/lib.dom.d.ts")).toBe(false);
  });
});
