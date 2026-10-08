#!/usr/bin/env bash
# Print the name@version of every workspace package whose current version is
# not on npm yet, one per line. Prints nothing when everything is published.
#
# A failed registry lookup counts as unpublished: the release workflow then
# asks for approval and `changeset publish` skips whatever already exists.
#
# Usage:
#   scripts/unpublished-packages.sh                    # packages/*/package.json
#   scripts/unpublished-packages.sh path/package.json  # specific manifests

set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  set -- "$MONOREPO_ROOT"/packages/*/package.json
fi

for manifest in "$@"; do
  if [ "$(jq -r '.private // false' "$manifest")" = "true" ]; then
    continue
  fi
  spec="$(jq -r '"\(.name)@\(.version)"' "$manifest")"
  if ! npm view "$spec" version >/dev/null 2>&1; then
    echo "$spec"
  fi
done
