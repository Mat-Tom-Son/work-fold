#!/bin/bash
set -euo pipefail
# Run only inside a disposable Fedora container with a non-root smoke user.
test "${WORKFOLD_CONTAINER_INSTALL_TEST:-}" = 1
test -f /.dockerenv || test -f /run/.containerenv
package=$1
upgrade=${2:-$package}
profile=/home/smoke/work-fold-install-fixture
credentials=/home/smoke/work-fold-credential-fixture
asar=/opt/work-fold/resources/app.asar
if test "$upgrade" != "$package"; then
  test "$(rpm -qp --qf '%{VERSION}-%{RELEASE}' "$upgrade")" != "$(rpm -qp --qf '%{VERSION}-%{RELEASE}' "$package")"
  # rpm -U below refuses a lower version; never pass --oldpackage.
fi
dnf install -y "$package"
test "$(readlink /usr/bin/work-fold)" = /opt/work-fold/bin/work-fold
test -x /usr/bin/work-fold-desktop
test -f /usr/share/applications/work-fold.desktop
mkdir -p /home/smoke/.config/work-fold /home/smoke/Documents/work-fold-preservation
echo preserve-profile > /home/smoke/.config/work-fold/preservation-test
echo preserve-folder > /home/smoke/Documents/work-fold-preservation/note.txt
runuser -u smoke -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase seed --expect-version "$(rpm -qp --qf '%{VERSION}' "$package")"
runuser -u smoke -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" seed "$asar"
rpm -Uvh --replacepkgs "$upgrade"
# The old postun must not remove the new installation's GUI or CLI launchers.
test "$(readlink /usr/bin/work-fold)" = /opt/work-fold/bin/work-fold
test -x /usr/bin/work-fold-desktop
runuser -u smoke -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase verify --expect-version "$(rpm -qp --qf '%{VERSION}' "$upgrade")"
runuser -u smoke -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" verify "$asar"
dnf remove -y work-fold-desktop
test ! -e /usr/bin/work-fold
test ! -L /usr/bin/work-fold
test ! -e /usr/bin/work-fold-desktop
test ! -e /opt/work-fold/work-fold-desktop
test "$(cat /home/smoke/.config/work-fold/preservation-test)" = preserve-profile
test "$(cat /home/smoke/Documents/work-fold-preservation/note.txt)" = preserve-folder
dnf install -y "$upgrade"
runuser -u smoke -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase verify --expect-version "$(rpm -qp --qf '%{VERSION}' "$upgrade")"
runuser -u smoke -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" verify "$asar"
dnf remove -y work-fold-desktop
echo 'PASS RPM install/replacement/removal/reinstall, persistent Pi/Chat/History/Library/request state, packaged credential stores and launcher ownership'
