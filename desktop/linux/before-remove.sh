#!/bin/bash
# RPM runs the old package's postun after installing its replacement. A numeric
# argument counts remaining installations: preserve all integration when nonzero.
# DEB uses named actions, so its existing hook behavior remains unchanged.
case "${1:-}" in
  ''|*[!0-9]*) ;;
  *) [ "$1" -eq 0 ] || exit 0 ;;
esac
