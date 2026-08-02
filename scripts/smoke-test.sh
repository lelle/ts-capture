#!/usr/bin/env bash
# Pre-publish smoke test for the @ts-capture/* tarballs.
#
# Builds tarballs from the monorepo with `pnpm pack`, scaffolds a fresh
# SvelteKit (minimal + TS + vitest) project at $TS_CAPTURE_SMOKE_DIR (default
# ../ts-capture-smoke-test), installs the tarballs as a real npm consumer
# would, runs vitest with ts-capture observation enabled, applies the
# collected types back to source, and asserts the inferred types compile
# and contain the expected signatures.
#
# Usage:
#   scripts/smoke-test.sh             # full rebuild from scratch (default)
#   scripts/smoke-test.sh --no-clean  # reuse existing test project (fast iteration)
#
# Env:
#   TS_CAPTURE_SMOKE_DIR   Override test project location.

set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PROJECT_DIR="${TS_CAPTURE_SMOKE_DIR:-${MONOREPO_ROOT}/../ts-capture-smoke-test}"
LOG_DIR="${TEST_PROJECT_DIR}/.smoke-logs"
TYPES_RUNTIME_DIR="${TEST_PROJECT_DIR}/.ts-capture-types"

CLEAN=true
for arg in "$@"; do
  case "$arg" in
    --no-clean) CLEAN=false ;;
    --help|-h)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

PACK_DIR=""
cleanup() {
  if [[ -n "$PACK_DIR" && -d "$PACK_DIR" ]]; then
    rm -rf "$PACK_DIR"
  fi
}
trap cleanup EXIT

step() {
  local name="$1"; shift
  echo "==> $name"
  local sanitized
  sanitized="$(echo "$name" | tr ' /:()' '______' | tr -cd '[:alnum:]_.-')"
  local log_file="${LOG_DIR}/${sanitized}.log"
  if "$@" > "$log_file" 2>&1; then
    echo "    OK"
  else
    local code=$?
    echo "    FAILED (exit $code). Last 30 lines of $log_file:"
    tail -30 "$log_file" | sed 's/^/      /'
    exit "$code"
  fi
}

# === 1. Pack tarballs from monorepo ===
echo "==> Packing tarballs from $MONOREPO_ROOT"
PACK_DIR="$(mktemp -d -t ts-capture-tarballs.XXXXXX)"
(cd "$MONOREPO_ROOT" && pnpm -r pack --pack-destination "$PACK_DIR" > /dev/null)
echo "    Tarballs:"
ls -1 "$PACK_DIR" | sed 's/^/      /'

# === 2. Clean test project dir if requested ===
if [[ "$CLEAN" == "true" && -d "$TEST_PROJECT_DIR" ]]; then
  echo "==> Removing existing $TEST_PROJECT_DIR"
  rm -rf "$TEST_PROJECT_DIR"
fi

mkdir -p "$LOG_DIR"

# === 3. Scaffold SvelteKit (minimal + TS, without add-ons) ===
# sv@0.15+'s --add vitest still triggers an interactive sub-prompt for
# usages even with --no-add-ons. Skip add-ons here; vitest is installed
# explicitly below.
if [[ ! -f "$TEST_PROJECT_DIR/package.json" ]]; then
  step "Scaffold SvelteKit minimal+ts" \
    npx --yes sv@latest create \
      --template minimal \
      --types ts \
      --no-add-ons \
      --no-install \
      --no-dir-check \
      --no-download-check \
      "$TEST_PROJECT_DIR"
fi

# === 4. Add untyped TS utility files + vitest specs ===
echo "==> Writing untyped utility files + specs"
mkdir -p "$TEST_PROJECT_DIR/src/lib"

cat > "$TEST_PROJECT_DIR/src/lib/greet.ts" <<'EOF'
export function greet(name) {
  return "Hello, " + name;
}
EOF

cat > "$TEST_PROJECT_DIR/src/lib/sum.ts" <<'EOF'
export function sum(a, b) {
  return a + b;
}
EOF

cat > "$TEST_PROJECT_DIR/src/lib/fetchUser.ts" <<'EOF'
export async function fetchUser(id) {
  return { id, name: "Ada", admin: false };
}
EOF

cat > "$TEST_PROJECT_DIR/src/lib/greet.spec.ts" <<'EOF'
import { describe, it, expect } from "vitest";
import { greet } from "./greet";

describe("greet", () => {
  it("formats a greeting", () => {
    expect(greet("World")).toBe("Hello, World");
  });
});
EOF

cat > "$TEST_PROJECT_DIR/src/lib/sum.spec.ts" <<'EOF'
import { describe, it, expect } from "vitest";
import { sum } from "./sum";

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
EOF

cat > "$TEST_PROJECT_DIR/src/lib/fetchUser.spec.ts" <<'EOF'
import { describe, it, expect } from "vitest";
import { fetchUser } from "./fetchUser";

describe("fetchUser", () => {
  it("returns a user", async () => {
    const u = await fetchUser(42);
    expect(u.name).toBe("Ada");
    expect(u.admin).toBe(false);
  });
});
EOF

# === 5. Overwrite vite.config.ts with a ts-capture-aware version ===
# The sv-create scaffold's own vite.config.ts gets tsCapturePlugin layered
# in here. Plugin order: tsCapturePlugin first (enforce: "pre" already set
# inside the plugin), then sveltekit().
cat > "$TEST_PROJECT_DIR/vite.config.ts" <<'EOF'
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";
import { tsCapturePlugin } from "@ts-capture/vite";

export default defineConfig({
  plugins: [tsCapturePlugin({ outputFile: "types.json" }), sveltekit()],
  test: {
    include: ["src/**/*.spec.ts"],
  },
});
EOF

# === 6. Install: sveltekit deps + ts-capture tarballs ===
cd "$TEST_PROJECT_DIR"

step "npm install (sveltekit baseline)" \
  npm install --no-audit --no-fund

step "npm install vitest + @types/node (sv create --add vitest is interactive)" \
  npm install --no-audit --no-fund --save-dev vitest @types/node

step "npm install (ts-capture tarballs)" \
  bash -c "npm install --no-audit --no-fund --save-dev '$PACK_DIR'/ts-capture-core-*.tgz '$PACK_DIR'/ts-capture-vite-*.tgz"

# === 7. svelte-kit sync (generates .svelte-kit/tsconfig.json) ===
step "svelte-kit sync" \
  npx svelte-kit sync

# === 8. git init: snapshot pre-apply state for diff verification ===
step "git init pre-apply snapshot" \
  bash -c "git init -q && git add -A && git -c user.email=smoke@test -c user.name=smoke commit -q -m pre-apply --allow-empty-message"

# === 9. Run vitest with TS_CAPTURE_TYPES_DIR set so we can find the dump ===
mkdir -p "$TYPES_RUNTIME_DIR"
rm -f "$TYPES_RUNTIME_DIR"/ts-capture-types-*.json
step "vitest run" \
  env TS_CAPTURE_TYPES_DIR="$TYPES_RUNTIME_DIR" npx vitest run

# === 10. Merge per-PID type dump(s) into types.json ===
# Vitest's default pool is "forks" with one fork per spec file, so each
# fork produces its own per-PID dump. `ts-capture merge` consolidates them.
step "ts-capture merge dumps → types.json" \
  npx ts-capture merge "$TYPES_RUNTIME_DIR" --out types.json

step "verify types.json has content" \
  bash -c "test -s types.json && [[ \$(wc -c < types.json) -gt 2 ]]"

# === 11. Apply collected types back to source ===
step "ts-capture apply types.json" \
  npx ts-capture apply types.json

# === 12. Verify src/ diff is non-empty (apply actually wrote something) ===
step "verify src/ diff is non-empty after apply" \
  bash -c "git diff --quiet src/ && exit 1 || exit 0"

# === 13. Verify the specific inferred signature appears ===
step "verify greet has inferred signature" \
  bash -c "grep -E 'function greet\\(name: string\\): string' src/lib/greet.ts"

# === 14. tsc --noEmit on the post-apply source ===
step "tsc --noEmit (post-apply)" \
  npx tsc --noEmit

echo ""
echo "✓ Smoke test PASSED"
echo "  Test project: $TEST_PROJECT_DIR"
echo "  Logs:         $LOG_DIR"
echo "  Diff:         (cd '$TEST_PROJECT_DIR' && git diff src/)"
