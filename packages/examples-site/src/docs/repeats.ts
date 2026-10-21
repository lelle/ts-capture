export interface Repeat {
  files: string[];
  text: string;
}

const RUN = 12;

/** Passages of twelve or more words in a row that appear in more than one file. */
export function findRepeats(files: Map<string, string>): Repeat[] {
  const runs = new Map<string, Set<string>>();
  const paragraphs = new Map<string, string[][]>();
  for (const [file, text] of files) {
    paragraphs.set(file, paragraphsOf(text));
    for (const words of paragraphs.get(file)!) {
      for (let i = 0; i + RUN <= words.length; i++) {
        const run = words.slice(i, i + RUN).join(" ");
        if (!runs.has(run)) runs.set(run, new Set());
        runs.get(run)!.add(file);
      }
    }
  }

  const repeats = new Map<string, Repeat>();
  for (const words of [...paragraphs.values()].flat()) {
    let start = -1;
    let shared = "";
    const close = (end: number): void => {
      if (start < 0) return;
      const text = words.slice(start, end + RUN - 1).join(" ");
      repeats.set(`${shared}\n${text}`, { files: shared.split("\n"), text });
      start = -1;
    };
    for (let i = 0; i + RUN <= words.length; i++) {
      const found = runs.get(words.slice(i, i + RUN).join(" "))!;
      const key = [...found].toSorted().join("\n");
      if (found.size < 2 || key !== shared) close(i);
      if (found.size >= 2 && start < 0) [start, shared] = [i, key];
    }
    close(words.length - RUN + 1);
  }
  return [...repeats.values()];
}

// Code blocks are left out: a how-to shows the commands it needs.
function paragraphsOf(markdown: string): string[][] {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map(
      (paragraph) =>
        paragraph
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join(" ")
          .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .toLowerCase()
          .match(/[\w@$<>-]+(?:[./][\w@$<>-]+)*/g) ?? [],
    );
}
