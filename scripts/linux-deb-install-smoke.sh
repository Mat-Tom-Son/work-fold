#!/bin/bash
set -euo pipefail
# This deliberately installs/removes packages only in the disposable Ubuntu
# build image. Never point it at an ordinary workstation or a personal profile.
test "${WORKFOLD_CONTAINER_INSTALL_TEST:-}" = 1
test -f /.dockerenv || test -f /run/.containerenv
package=$1
upgrade=${2:-$package}
profile=/home/ubuntu/work-fold-install-fixture
credentials=/home/ubuntu/work-fold-credential-fixture
asar=/opt/work-fold/resources/app.asar
if test "$upgrade" != "$package"; then
  dpkg --compare-versions "$(dpkg-deb -f "$upgrade" Version)" gt "$(dpkg-deb -f "$package" Version)"
fi
dpkg --install "$package"
test "$(readlink /usr/bin/work-fold)" = /opt/work-fold/bin/work-fold
test -f /usr/share/applications/work-fold.desktop
test -f /opt/work-fold/resources/apparmor-profile
test -f /opt/work-fold/bin/THIRD-PARTY-LICENSES.txt
mkdir -p /home/ubuntu/.config/work-fold /home/ubuntu/Documents/work-fold-preservation
echo preserve-profile > /home/ubuntu/.config/work-fold/preservation-test
echo preserve-folder > /home/ubuntu/Documents/work-fold-preservation/note.txt
runuser -u ubuntu -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase seed --expect-version "$(dpkg-deb -f "$package" Version)"
runuser -u ubuntu -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" seed "$asar"
dpkg --install "$upgrade"
runuser -u ubuntu -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase verify --expect-version "$(dpkg-deb -f "$upgrade" Version)"
runuser -u ubuntu -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" verify "$asar"
dpkg --purge work-fold-desktop
test ! -e /usr/bin/work-fold
test ! -L /usr/bin/work-fold
test ! -e /opt/work-fold/work-fold-desktop
test "$(cat /home/ubuntu/.config/work-fold/preservation-test)" = preserve-profile
test "$(cat /home/ubuntu/Documents/work-fold-preservation/note.txt)" = preserve-folder
dpkg --install "$upgrade"
runuser -u ubuntu -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase verify --expect-version "$(dpkg-deb -f "$upgrade" Version)"
runuser -u ubuntu -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" verify "$asar"
dpkg --purge work-fold-desktop
echo unrelated-cli > /usr/bin/work-fold
dpkg --install "$package"
test "$(cat /usr/bin/work-fold)" = unrelated-cli
dpkg --purge work-fold-desktop
test "$(cat /usr/bin/work-fold)" = unrelated-cli
echo 'PASS DEB install/replacement/removal/reinstall, persistent Pi/Chat/History/Library/request state, packaged credential stores and unrelated CLI ownership'
