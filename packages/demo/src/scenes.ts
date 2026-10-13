// What the recording shows that is not a file's own text: the numbers and
// lines taken from the tools' output, shaped for the stage.

/** The percentage in what `ts-capture coverage` printed. */
export function coveragePercent(output: string): string {
  const match = /Type coverage: ([\d.]+%)/.exec(output);
  if (!match)
    throw new Error(
      `no coverage in the output of \`ts-capture coverage\`:\n${output}`,
    );
  return match[1];
}

/** What a command printed, as the lines a terminal would show. */
export function terminalLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
