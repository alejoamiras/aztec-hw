#!/usr/bin/env bash
# M12 finalize — the ONE blocked step, packaged + pre-verified.
#
# Everything else in the M12 arc is done (P0–P3 + P7, gates green). The only
# remaining DONE criterion is "four signed safe-vN tags pushed", which was blocked
# all of the implementation session because the 1Password SSH agent could not sign
# (`ssh -T git@github.com` → "communication with agent failed"). This script does
# that step in one shot, AFTER you re-unlock 1Password.
#
# It is SAFE to run only when signing works — it PRECHECKS (a throwaway signed tag)
# and aborts before touching history if the agent still can't sign. The
# phase→commit mapping below was verified against the pre-rebase tree
# (each grep matched exactly one commit).
#
#   bash scripts/m12-finalize-tags.sh
#
# WHY the rebase + grep: the M12 commits landed UNSIGNED (AFK bypass). Backfilling
# signatures (`rebase --exec … -S`) REWRITES every commit hash, so we must tag by
# commit MESSAGE (stable) not the pre-rebase hash (stale). Tags: v15=P0, v16=P1,
# v17=P2-complete (differential-replay green), v18=P3 (cx_math decision). The P7
# review-fold + index commits ride on the branch HEAD above v18 (not their own tag,
# per the plan's v15–v18 = P0–P3).
set -euo pipefail

BRANCH="m12-consolidation-fuzz"
BASE="safe-v14"

# tag : commit-message grep  (verified: each matches exactly one commit)
MAP=(
  "safe-v15:refactor(m12 P0)"
  "safe-v16:refactor(m12 P1)"
  "safe-v17:differential-replay gate — GREEN"
  "safe-v18:cx_math prototype-spike"
)

cd "$(git rev-parse --show-toplevel)"

[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "ABORT: not on $BRANCH"; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then echo "ABORT: working tree dirty"; exit 1; fi
git rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "ABORT: base $BASE missing"; exit 1; }

# --- PRECHECK: signing must actually work, else abort before rewriting history ---
echo "Precheck: can the SSH/1Password agent sign?"
if ! git tag -s __m12_signtest__ -m precheck HEAD >/dev/null 2>&1; then
  echo "ABORT: signing failed — re-unlock 1Password (the SSH agent can't sign yet)." >&2
  git tag -d __m12_signtest__ >/dev/null 2>&1 || true
  exit 2
fi
git tag -d __m12_signtest__ >/dev/null 2>&1
echo "  signing OK."

# --- 1. Backfill signatures over the AFK commits (rewrites hashes) ---
echo "Backfill-signing $BASE..HEAD …"
git rebase --exec 'git commit --amend --no-edit -S' "$BASE"

# --- 2. Create the four SIGNED phase tags on the post-rebase commits ---
for entry in "${MAP[@]}"; do
  tag="${entry%%:*}"; pat="${entry#*:}"
  commit="$(git log -1 --format=%H --grep="$pat")"
  [ -n "$commit" ] || { echo "ABORT: no commit matched '$pat' for $tag"; exit 1; }
  if git rev-parse --verify "$tag" >/dev/null 2>&1; then
    echo "  $tag already exists — skipping (delete it first to re-tag)"
  else
    git tag -s "$tag" "$commit" -m "M12 $tag — $pat"
    echo "  tagged $tag → $(git rev-parse --short "$commit")"
  fi
done

# --- 3. Push the branch + the four tags (branch was never pushed → plain push) ---
echo "Pushing branch + tags …"
git push -u origin "$BRANCH"
git push origin safe-v15 safe-v16 safe-v17 safe-v18

echo "DONE: M12 branch + signed safe-v15..v18 pushed. Verify on GitHub (Verified badge)."
echo "Then re-enable per-commit signing going forward: git config commit.gpgsign true"
