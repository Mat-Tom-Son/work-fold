#!/bin/sh
set -eu
# Keep the GUI launcher and shell command distinct. Never overwrite an unrelated CLI.
workfold_cli='/opt/${sanitizedProductName}/bin/work-fold'
if [ ! -e /usr/bin/work-fold ] && [ ! -L /usr/bin/work-fold ]; then
  ln -s "$workfold_cli" /usr/bin/work-fold
elif [ "$(readlink /usr/bin/work-fold 2>/dev/null || true)" = "$workfold_cli" ]; then
  :
else
  echo 'work-fold: /usr/bin/work-fold is already owned by another installation; leaving it unchanged.' >&2
fi
