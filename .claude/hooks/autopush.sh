#!/usr/bin/env bash
# Claude Code Stop hook: after each response, commit anything left uncommitted
# in this repo and push it (pushing to main deploys the app on Vercel).
# Claude normally commits with a real message first; this catches the rest.
# Never blocks: always exits 0 and reports through a systemMessage.

say() { printf '{"systemMessage": "%s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
branch=$(git symbolic-ref --short -q HEAD) || exit 0   # detached HEAD: leave it alone
[ -e "$(git rev-parse --git-dir)/MERGE_HEAD" ] && exit 0  # mid-merge: leave it alone

committed=""
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    n=$(git diff --cached --name-only | wc -l | tr -d ' ')
    files=$(git diff --cached --name-only | head -4 | awk 'BEGIN { ORS = ", " } { print }' | sed 's/, $//')
    [ "$n" -gt 4 ] && files="$files and $((n - 4)) more"
    if git commit -q -m "Update $files" \
         -m "Auto-committed by the Claude Code Stop hook (.claude/hooks/autopush.sh)." \
         -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; then
      committed="Committed: Update $files. "
    else
      say "Auto-commit failed; changes are staged but not committed."
      exit 0
    fi
  fi
fi

# Push whenever this branch has commits the remote doesn't (or has no upstream yet).
if upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)
else
  ahead=1
fi
if [ "${ahead:-0}" -gt 0 ]; then
  if out=$(git push -q -u origin "$branch" 2>&1); then
    say "${committed}Pushed $branch to origin."
  else
    say "${committed}Push failed: $(printf '%s' "$out" | tail -1)"
  fi
elif [ -n "$committed" ]; then
  say "$committed"
fi
exit 0
