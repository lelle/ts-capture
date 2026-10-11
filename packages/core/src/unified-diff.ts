type Op = { kind: " " | "-" | "+"; line: string };

const CONTEXT = 3;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Myers' shortest edit script, line by line. */
function editScript(before: string[], after: string[]): Op[] {
  const reach = (furthest: Map<number, number>, k: number) => furthest.get(k) ?? 0;
  const goesDown = (furthest: Map<number, number>, k: number, d: number) =>
    k === -d || (k !== d && reach(furthest, k - 1) < reach(furthest, k + 1));

  const rounds: Map<number, number>[] = [];
  const furthest = new Map<number, number>([[1, 0]]);
  search: for (let d = 0; d <= before.length + after.length; d++) {
    rounds.push(new Map(furthest));
    for (let k = -d; k <= d; k += 2) {
      let x = goesDown(furthest, k, d) ? reach(furthest, k + 1) : reach(furthest, k - 1) + 1;
      while (x < before.length && x - k < after.length && before[x] === after[x - k]) x++;
      furthest.set(k, x);
      if (x >= before.length && x - k >= after.length) break search;
    }
  }

  const ops: Op[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = rounds.length - 1; d >= 0; d--) {
    const k = x - y;
    const previousK = goesDown(rounds[d], k, d) ? k + 1 : k - 1;
    const previousX = reach(rounds[d], previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ kind: " ", line: before[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === previousX) ops.push({ kind: "+", line: after[y - 1] });
      else ops.push({ kind: "-", line: before[x - 1] });
    }
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

function hunkRanges(ops: Op[]): [start: number, end: number][] {
  const ranges: [number, number][] = [];
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(ops.length, index + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  });
  return ranges;
}

/** `before` against `after` as a unified diff, or `""` when they are the same. */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const ops = editScript(splitLines(before), splitLines(after));
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start, end] of hunkRanges(ops)) {
    const leading = ops.slice(0, start);
    const hunk = ops.slice(start, end);
    const oldStart = leading.filter((op) => op.kind !== "+").length;
    const newStart = leading.filter((op) => op.kind !== "-").length;
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`,
      ...hunk.map((op) => op.kind + op.line),
    );
  }
  return `${out.join("\n")}\n`;
}
