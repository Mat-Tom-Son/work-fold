#!/bin/sh
# Natural-language management dogfood against the dev desktop app.
# Prereq: launch the dev app once (npx electron .) and set a provider API key
# in Settings -> Assistant for the "Workspace Development" profile.
set -eu
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEVSTATE="$HOME/Library/Application Support/Workspace Development"
BIN=$(mktemp -d)
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
NOTE=$(mktemp -t dogfood-note)
printf 'Vendor quote for the Q3 audit: Meridian Instruments, $12,400, net-30.\n' > "$NOTE"
echo "== management identity turn"
TASK=$("$BIN/workspace" manage send --message "In one short paragraph: who are you, and what Spaces exist right now? Check with your workspace command." --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["taskId"])')
"$BIN/workspace" manage wait --task "$TASK" --timeout 300
echo "== full organize-and-delegate turn"
TASK=$("$BIN/workspace" manage send --message "Create a Space named 'Dogfood NL'. Add the file $NOTE into it under 'Inbox' with a restore point. Then send that Space's Assistant a new chat asking it to reply with exactly ACKNOWLEDGED, wait for that exact task, and report the Space id, copied path, restore-point id, and delegated task outcome." --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["taskId"])')
"$BIN/workspace" manage wait --task "$TASK" --timeout 600
echo "== receipts tail"
tail -12 "$DEVSTATE/cli/receipts/act.jsonl"
