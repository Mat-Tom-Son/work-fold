#!/bin/sh
set -eu
workfold_cli='/opt/${sanitizedProductName}/bin/work-fold'
if [ "$(readlink /usr/bin/work-fold 2>/dev/null || true)" = "$workfold_cli" ]; then
  rm /usr/bin/work-fold
fi
# Folders, Pi resources, credentials, and application data belong to the person.
