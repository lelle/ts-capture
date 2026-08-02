import type { CollectedTypeInfo } from "@ts-capture/core";

import { createProjectVerificationContext } from "@ts-capture/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sveltePlugin } from "./index.js";

/**
 * Applying type observations into a .svelte file must run
 * the same typecheck-verify the .ts path uses, so observed-concrete
 * shapes that would break the build are dropped.
 *
 * Each test builds a tiny on-temp-dir project (a real .ts module the
 * block imports), then drives `sveltePlugin().apply` both WITHOUT a
 * project verifier (reproduces the regression) and WITH one (must
 * drop the unsafe annotations).
 */
describe("svelte apply typecheck-verify", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ts-capture-svelte-verify-"),
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function makeProject(files: Record<string, string>): {
    dir: string;
    fileNames: string[];
    compilerOptions: ts.CompilerOptions;
  } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "p-"));
    const tsconfig = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    };
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dir);
    return {
      dir,
      fileNames: parsed.fileNames,
      compilerOptions: parsed.options,
    };
  }

  it("drops observed-concrete annotations that would break types; keeps source clean", () => {
    // A real imported module whose return type is broader than what a
    // single capture session observes (Partial<...>), plus a built-in
    // nullable return (String.match -> RegExpMatchArray | null).
    const proj = makeProject({
      "ctx.ts": [
        "export interface UrlCtx { plate?: string }",
        "export function getCtx(): Partial<UrlCtx> { return {} }",
        "",
      ].join("\n"),
    });

    const svelteFile = path.join(proj.dir, "Comp.svelte");
    const scriptBody =
      "\nimport { getCtx } from './ctx'\n" +
      "const matched = 'DP1'.match(/(\\w)(\\d)/)\n" +
      "const ctxVal = getCtx()\n";
    const svelteSource = `<script lang="ts">${scriptBody}</script>`;

    const prefix = `${svelteFile}__script.ts`;
    const matchedEnd = scriptBody.indexOf("matched") + "matched".length;
    const ctxValEnd = scriptBody.indexOf("ctxVal") + "ctxVal".length;
    const typeInfo: CollectedTypeInfo = [
      // String.match observed as string[] this session — really RegExpMatchArray | null.
      [prefix, matchedEnd, [["string[]", undefined]], { varDecl: true }],
      // getCtx() observed concrete — really Partial<UrlCtx> (plate optional).
      [
        prefix,
        ctxValEnd,
        [["{ plate: string }", undefined]],
        { varDecl: true },
      ],
    ];

    // Sanity: without a verifier the regression is reproduced.
    const noVerify = sveltePlugin().apply(svelteSource, typeInfo, {
      filename: svelteFile,
    });
    expect(noVerify).toMatch(/matched\s*:\s*string\[\]/);
    expect(noVerify).toMatch(/ctxVal\s*:\s*\{[^}]*plate/);

    // With the project verifier the unsafe annotations must be dropped.
    const projectVerify = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verified = sveltePlugin().apply(svelteSource, typeInfo, {
      filename: svelteFile,
      projectVerify,
    });
    expect(verified).not.toMatch(/matched\s*:\s*string\[\]/);
    expect(verified).not.toMatch(/ctxVal\s*:\s*\{[^}]*plate/);
  });

  it("keeps a sound annotation while dropping an unsound one in the same block", () => {
    const proj = makeProject({
      "ctx.ts": [
        "export function getCtx(): string | undefined { return undefined }",
        "",
      ].join("\n"),
    });

    const svelteFile = path.join(proj.dir, "Comp.svelte");
    const scriptBody =
      "\nimport { getCtx } from './ctx'\n" +
      "const sound = getCtx()\n" + // really string | undefined
      "const unsound = getCtx()\n"; // also string | undefined
    const svelteSource = `<script lang="ts">${scriptBody}</script>`;

    const prefix = `${svelteFile}__script.ts`;
    const soundEnd = scriptBody.indexOf("sound") + "sound".length;
    const unsoundEnd = scriptBody.indexOf("unsound") + "unsound".length;
    const typeInfo: CollectedTypeInfo = [
      // Sound: matches the real type exactly.
      [
        prefix,
        soundEnd,
        [["string | undefined", undefined]],
        { varDecl: true },
      ],
      // Unsound: drops the undefined branch.
      [prefix, unsoundEnd, [["string", undefined]], { varDecl: true }],
    ];

    const projectVerify = createProjectVerificationContext(
      proj.fileNames,
      proj.compilerOptions,
      proj.dir,
    );
    const verified = sveltePlugin().apply(svelteSource, typeInfo, {
      filename: svelteFile,
      projectVerify,
    });
    expect(verified).toMatch(/sound\s*:\s*string \| undefined/);
    expect(verified).not.toMatch(/unsound\s*:\s*string(?!\s*\|)/);
  });
});
