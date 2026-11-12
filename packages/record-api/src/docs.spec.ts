import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const howTo = resolve(
  here,
  "../../../docs/how-to/type-a-service-from-its-responses.md",
);

describe("the how-to", () => {
  it("shows recorder.ts as it is", () => {
    const shown = /```ts title="recorder\.ts"\n([\s\S]*?)```/.exec(
      readFileSync(howTo, "utf-8"),
    )?.[1];
    expect(shown).toBe(readFileSync(resolve(here, "recorder.ts"), "utf-8"));
  });
});
