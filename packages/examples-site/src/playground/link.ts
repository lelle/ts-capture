/** The code a link to the playground carries, `#code=<encoded>`; undefined when there is none. */
export function codeFromHash(hash: string): string | undefined {
  const match = /^#code=(.*)$/s.exec(hash);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}
