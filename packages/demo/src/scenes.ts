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

/** Where step `step`'s still goes; a page loads the 1x one unless the screen is dense. */
export function stillName(step: number, scale: 1 | 2): string {
  return scale === 1 ? `demo-${step}.webp` : `demo-${step}@2x.webp`;
}

/** `img2webp`'s arguments for the README's animation of the steps. */
export function animationArgs(frames: string[], out: string): string[] {
  const held = frames.flatMap((frame, i) => [
    "-d",
    i === frames.length - 1 ? "5000" : "3500",
    frame,
  ]);
  return ["-loop", "0", "-lossless", "-m", "6", ...held, "-o", out];
}
