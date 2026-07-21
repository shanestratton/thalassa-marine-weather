#!/usr/bin/env bash
# Surfaces changes to the multi-Claude coordination file (docs/ROUTING_COLLAB.md)
# so this session reads them whenever they change — Shane's standing rule.
# Wired as a UserPromptSubmit hook; stdout is injected into the model's context.
# Emits nothing when the file is unchanged since last seen (no noise).
set -uo pipefail

DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
FILE="$DIR/docs/ROUTING_COLLAB.md"
STATE="$DIR/.claude/.collab-watch-seen"

[ -f "$FILE" ] || exit 0

# Content hash (git when available, else shasum) — catches even uncommitted edits.
HASH="$(git -C "$DIR" hash-object "$FILE" 2>/dev/null || shasum "$FILE" 2>/dev/null | awk '{print $1}')"
[ -n "$HASH" ] || exit 0

PREV=""
[ -f "$STATE" ] && PREV="$(cat "$STATE" 2>/dev/null || true)"

if [ "$HASH" != "$PREV" ]; then
    echo "<collab-file-update file=\"docs/ROUTING_COLLAB.md\">"
    echo "This shared multi-Claude coordination file changed since you last saw it. Read it for anything pertaining to your work — you edit shared UI files (components/map/MapHub.tsx, components/map/RadialHelmMenu.tsx). The latest entries:"
    echo "----"
    tail -n 50 "$FILE"
    echo "----"
    echo "(Full file: docs/ROUTING_COLLAB.md. git pull before editing it — it is git-tracked and shared.)"
    echo "</collab-file-update>"
    mkdir -p "$DIR/.claude"
    printf '%s' "$HASH" > "$STATE"
fi
exit 0
