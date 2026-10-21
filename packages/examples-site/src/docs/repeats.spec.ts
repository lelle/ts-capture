import { describe, expect, it } from "vitest";

import { findRepeats } from "./repeats.js";

// Each fact is explained in one place; the others link to it. Twelve words
// in a row is a sentence, not a phrase two pages happen to share.

const SENTENCE =
  "Every run removes the notes it finds and writes the ones that hold now.";

describe("findRepeats", () => {
  it("names both files and the words they share", () => {
    const repeats = findRepeats(
      new Map([
        ["a.md", `# A\n\nFirst. ${SENTENCE}\n`],
        ["b.md", `# B\n\n${SENTENCE} Then more.\n`],
      ]),
    );
    expect(repeats).toEqual([
      {
        files: ["a.md", "b.md"],
        text: "every run removes the notes it finds and writes the ones that hold now",
      },
    ]);
  });

  it("lets eleven words in a row through", () => {
    const eleven = "one two three four five six seven eight nine ten eleven";
    expect(
      findRepeats(
        new Map([
          ["a.md", `${eleven}.\n`],
          ["b.md", `${eleven}.\n`],
        ]),
      ),
    ).toEqual([]);
  });

  it("reads a link by its text, and a line break as a space", () => {
    const repeats = findRepeats(
      new Map([
        [
          "a.md",
          "Every run removes the notes it finds and\nwrites the [ones](x.md) that hold now.\n",
        ],
        ["b.md", `${SENTENCE}\n`],
      ]),
    );
    expect(repeats.map((repeat) => repeat.files)).toEqual([["a.md", "b.md"]]);
  });

  it("leaves code blocks out, since a command is shown where it is needed", () => {
    const block = "```sh\n" + SENTENCE + "\n```\n";
    expect(
      findRepeats(
        new Map([
          ["a.md", block],
          ["b.md", block],
        ]),
      ),
    ).toEqual([]);
  });

  it("does not run a sentence on from one paragraph or heading into the next", () => {
    const [head, tail] = [
      "Every run removes the notes it finds and",
      "writes the ones that hold now.",
    ];
    expect(
      findRepeats(
        new Map([
          ["a.md", `${head}\n\n${tail}\n`],
          ["b.md", `## ${head}\n${tail}\n`],
          ["c.md", `${SENTENCE}\n`],
        ]),
      ),
    ).toEqual([]);
  });

  it("reports a longer passage once, not once per twelve words", () => {
    const passage = `${SENTENCE} Nothing checks a comment the way tsc checks an annotation.`;
    expect(
      findRepeats(
        new Map([
          ["a.md", `${passage}\n`],
          ["b.md", `${passage}\n`],
        ]),
      ),
    ).toHaveLength(1);
  });

  it("does not count a sentence repeated within one file", () => {
    expect(
      findRepeats(new Map([["a.md", `${SENTENCE}\n\n${SENTENCE}\n`]])),
    ).toEqual([]);
  });
});
