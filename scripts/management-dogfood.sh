#!/bin/sh
# Natural-language management dogfood against a fresh dev desktop app.
# Prereq: set a provider API key in Settings -> Assistant for the "Workspace
# Development" profile, then fully quit that app before running this script.
set -eu
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEVSTATE="$HOME/Library/Application Support/Workspace Development"
BIN="$REPO/out/management-dogfood/bin"
LOG="$REPO/out/management-dogfood/desktop.log"
mkdir -p "$BIN"
cat > "$BIN/app-wrapper.sh" <<WRAP
#!/bin/sh
exec "$REPO/node_modules/.bin/electron" "$REPO" "\$@"
WRAP
cat > "$BIN/workspace" <<SHIM
#!/bin/sh
export WORKSPACE_CLI_APP="$BIN/app-wrapper.sh"
export WORKSPACE_CLI_STATE_DIR="$DEVSTATE"
exec /usr/bin/osascript -l JavaScript "$REPO/desktop/cli/workspace-cli.jxa.js" "$REPO/desktop/cli" "\$@"
SHIM
chmod +x "$BIN/app-wrapper.sh" "$BIN/workspace"
if [ -f "$DEVSTATE/cli/act-token.json" ]; then
  echo "Workspace Development still has an act token. Fully quit the dev app, then rerun this script." >&2
  exit 1
fi

# The interactive app must inherit this bin directory: management turns find
# the exact same dev shim by typing `workspace`, just as packaged turns inherit
# the bundle's Contents/bin directory.
PATH="$BIN:$PATH" "$BIN/app-wrapper.sh" >"$LOG" 2>&1 &
attempt=0
while [ ! -f "$DEVSTATE/cli/act-token.json" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Workspace Development did not become ready; see $LOG" >&2
    exit 1
  fi
  sleep 1
done

NOTE=$(mktemp -t dogfood-note)
trap 'rm -f "$NOTE"' EXIT
printf 'Vendor quote for the Q3 audit: Meridian Instruments, $12,400, net-30.\n' > "$NOTE"
echo "== management identity turn"
TASK=$("$BIN/workspace" manage send --message "In one short paragraph: who are you, and what Spaces exist right now? Check with your workspace command." --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).data.taskId))')
"$BIN/workspace" manage wait --task "$TASK" --timeout 300
echo "== full organize-and-delegate turn"
TASK=$("$BIN/workspace" manage send --message "Create a Space named 'Dogfood NL'. Add the file $NOTE into it under 'Inbox' with a restore point. Then send that Space's Assistant a new chat asking it to reply with exactly ACKNOWLEDGED, wait for that exact task, and report the Space id, copied path, restore-point id, and delegated task outcome." --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).data.taskId))')
"$BIN/workspace" manage wait --task "$TASK" --timeout 600
echo "== receipts tail"
tail -12 "$DEVSTATE/cli/receipts/act.jsonl"
echo "Workspace Development remains open with the dogfood shim available at $BIN/workspace."
