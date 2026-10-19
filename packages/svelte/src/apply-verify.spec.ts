import { createProjectVerificationContext } from "@ts-capture/core";
import { describe, expect, it } from "vitest";

import { type Applied, entry } from "../../core/src/test-utils/applied.js";
import { endOf } from "../../core/src/test-utils/instrumented.js";
import "../../core/src/test-utils/matchers.js";
import { makeProject } from "../../core/src/test-utils/project.js";
import { sveltePlugin } from "./index.js";
import { appliedSvelte } from "./test-utils/applied-svelte.js";

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
  /**
   * Apply `observed`, a type per declared name, to a component whose script
   * block is `body`, and hold the block that comes back.
   */
  function annotated(
    body: string,
    observed: Record<string, string>,
    files: Record<string, string>,
    how: "unverified" | "verified",
  ): Applied {
    const project = makeProject(files);
    const filename = project.pathOf("Comp.svelte");
    const source = `<script lang="ts">${body}</script>`;
    const entries = Object.entries(observed).map(([name, type]) =>
      entry(`${filename}__script.ts`, endOf(body, name), [[type]], {
        varDecl: true,
      }),
    );
    const projectVerify =
      how === "verified"
        ? createProjectVerificationContext(
            project.fileNames,
            project.compilerOptions,
            project.dir,
          )
        : undefined;
    const { text } = sveltePlugin().apply(source, entries, {
      filename,
      projectVerify,
    });
    const { script } = appliedSvelte(source, text, { files });
    if (!script) throw new Error(`no script block in:\n${text}`);
    return script;
  }

  it("drops observed-concrete annotations that would break types; keeps source clean", () => {
    // A real imported module whose return type is broader than what a
    // single capture session observes (Partial<...>), plus a built-in
    // nullable return (String.match -> RegExpMatchArray | null).
    const files = {
      "ctx.ts": [
        "export interface UrlCtx { plate?: string }",
        "export function getCtx(): Partial<UrlCtx> { return {} }",
        "",
      ].join("\n"),
    };
    const body =
      "\nimport { getCtx } from './ctx'\n" +
      "const matched = 'DP1'.match(/(\\w)(\\d)/)\n" +
      "const ctxVal = getCtx()\n";
    const observed = {
      // String.match observed as string[] this session — really RegExpMatchArray | null.
      matched: "string[]",
      // getCtx() observed concrete — really Partial<UrlCtx> (plate optional).
      ctxVal: "{ plate: string }",
    };

    // Sanity: without a verifier the regression is reproduced.
    const unverified = annotated(body, observed, files, "unverified");
    expect(unverified).toAnnotate("matched", "string[]");
    expect(unverified).toAnnotate("ctxVal", "{ plate: string }");
    expect(unverified).not.toHaveNoNewDiagnostics();

    // With the project verifier the unsafe annotations must be dropped.
    const out = annotated(body, observed, files, "verified");
    expect(out).toLeaveUntyped("matched");
    expect(out).toLeaveUntyped("ctxVal");
    expect(out).toHaveNoNewDiagnostics();
  });

  it("annotates a destructured $props() declaration", () => {
    const out = annotated(
      "\nlet { host, guest } = $props()\n",
      { "{ host, guest }": "{ host: string, guest: string }" },
      { "noop.ts": "export const noop = 0;\n" },
      "verified",
    );
    expect(out).toAnnotate(
      "{ host, guest }",
      "{ host: string; guest: string }",
    );
    expect(out).toHaveNoNewDiagnostics();
  });

  it("keeps a sound annotation while dropping an unsound one in the same block", () => {
    const files = {
      "ctx.ts": [
        "export function getCtx(): string | undefined { return undefined }",
        // Untyped on purpose: TypeScript infers `any` from it, so an
        // annotation here genuinely adds information and is not suppressed as
        // redundant before verify ever sees it.
        "export function getOpaque(x) { return x }",
        "",
      ].join("\n"),
    };
    const body =
      "\nimport { getCtx, getOpaque } from './ctx'\n" +
      "const sound = getOpaque('x')\n" + // TS infers `any`; ours informs
      "const unsound = getCtx()\n"; // also string | undefined
    const out = annotated(
      body,
      {
        // Matches the real type exactly.
        "const sound": "string | undefined",
        // Drops the undefined branch and must be rejected by verify.
        "const unsound": "string",
      },
      files,
      "verified",
    );
    expect(out).toAnnotate("sound", "string | undefined");
    expect(out).toLeaveUntyped("unsound");
    expect(out).toHaveNoNewDiagnostics();
  });

  // So `apply --report` can point into the component, not into the block.
  it("says why it dropped one, at its position in the .svelte file", () => {
    const project = makeProject({
      "ctx.ts":
        "export function getCtx(): string | undefined { return undefined }\n",
    });
    const filename = project.pathOf("Comp.svelte");
    const body = "\nimport { getCtx } from './ctx'\nconst unsound = getCtx()\n";
    const source = `<script lang="ts">${body}</script>`;
    const result = sveltePlugin().apply(
      source,
      [
        entry(
          `${filename}__script.ts`,
          endOf(body, "const unsound"),
          [["string"]],
          {
            varDecl: true,
          },
        ),
      ],
      {
        filename,
        projectVerify: createProjectVerificationContext(
          project.fileNames,
          project.compilerOptions,
          project.dir,
        ),
      },
    );
    expect(result.skips).toEqual([
      expect.objectContaining({
        pos: source.indexOf("unsound") + "unsound".length,
        reason: "type-error",
      }),
    ]);
  });
});
