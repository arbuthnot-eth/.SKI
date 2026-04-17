#!/usr/bin/env bash
# One-shot opt-in: point this clone's hooks at .githooks/ so the
# commit-msg hook runs on every commit. Idempotent.
#
# Usage: bash scripts/install-git-hooks.sh

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ ! -d .githooks ]]; then
    printf '✗ .githooks/ not found at %s\n' "$repo_root" >&2
    exit 1
fi

chmod +x .githooks/*
git config core.hooksPath .githooks

printf 'Installed git hooks from .githooks/ → %s\n' "$(git config --get core.hooksPath)"
for h in .githooks/*; do
    [[ -f "$h" ]] || continue
    printf '  • %s\n' "$(basename "$h")"
done
