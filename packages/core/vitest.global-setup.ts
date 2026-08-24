import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Five specs — cli, e2e, preload, setup, register — run the *built* package:
// they spawn `node dist/cli.js` or import `dist/*.cjs`, because what they are
// testing is the thing a user installs. So `vitest run` on its own measures
// whatever was built last, and a source change that has not been compiled is
// invisible to them.
//
// That is not theoretical. Two CLI tests written for a fix passed against the
// stale binary — green for the behaviour the fix was meant to remove — and
// only failed once `dist` caught up. A comment asking the next person to
// remember to build is not a fix; this is.
//
// Cheap when there is nothing to do: one `stat` per file, and the build runs
// only when a source file is newer than the artefacts. CI builds before it
// tests, so there it always finds them current.

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTEFACTS = ["dist/cli.js", "dist/index.cjs", "dist/preload.cjs", "dist/setup.cjs"];

/** Newest mtime among the sources the build reads. Specs are not among them. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

export default function ensureBuilt(): void {
  const source = newestSourceMtime(path.join(here, "src"));
  const built = ARTEFACTS.map((rel) => {
    const full = path.join(here, rel);
    return fs.existsSync(full) ? fs.statSync(full).mtimeMs : 0;
  });

  if (built.every((mtime) => mtime > source)) return;

  const missing = ARTEFACTS.filter((rel) => !fs.existsSync(path.join(here, rel)));
  process.stderr.write(
    missing.length > 0
      ? `[vitest] building @ts-capture/core — ${missing.join(", ")} missing\n`
      : `[vitest] building @ts-capture/core — a source file is newer than dist\n`,
  );
  // Inherit stdio: a build failure should read like a build failure, not like
  // an inscrutable setup error.
  execFileSync("pnpm", ["run", "build"], { cwd: here, stdio: "inherit" });
}
