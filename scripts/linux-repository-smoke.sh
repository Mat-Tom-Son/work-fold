#!/bin/bash
set -euo pipefail
# Installs and alters package-manager configuration only in disposable containers.
test "${WORKFOLD_CONTAINER_INSTALL_TEST:-}" = 1
test -f /.dockerenv || test -f /run/.containerenv
test "$(id -u)" = 0
older=$(realpath "$1")
newer=$(realpath "$2")
kind=$3
work=$(mktemp -d /tmp/workfold-repository-smoke.XXXXXX)
repository="$work/repository"
chmod 755 "$work"
trap 'rm -rf "$work"' EXIT
version() { node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$1/repository.json"; }
old_version=$(version "$older")
new_version=$(version "$newer")
test "$old_version" != "$new_version"
cmp "$older/work-fold-signing-key.gpg" "$newer/work-fold-signing-key.gpg"
expect_failure() {
  local pattern=$1
  shift
  if "$@" > "$work/rejection.log" 2>&1; then echo "FAIL: expected rejection: $*"; exit 1; fi
  if ! grep -Eiq "$pattern" "$work/rejection.log"; then cat "$work/rejection.log"; echo 'FAIL: unrelated error'; exit 1; fi
  echo "PASS rejected: $pattern"
}
switch_repo() {
  rm -rf "$repository"
  # Fresh publication times matter to file:// conditional fetches just as new
  # Last-Modified values matter on a web host. Do not preserve staging mtimes.
  cp -R "$1" "$repository"
  chmod -R a+rX "$repository"
}
smoke() {
  runuser -u "$smoke_user" -- dbus-run-session -- xvfb-run -a node /work/scripts/linux-installed-smoke.mjs \
    /opt/work-fold/work-fold-desktop /usr/bin/work-fold --profile-root "$profile" --phase "$1" --expect-version "$2"
  runuser -u "$smoke_user" -- bash /work/scripts/linux-credentials-smoke.sh "$credentials" "$1" /opt/work-fold/resources/app.asar
}

if test "$kind" = apt; then
  smoke_user=ubuntu
  profile=/home/ubuntu/workfold-signed-install
  credentials=/home/ubuntu/workfold-signed-credentials
  dpkg --compare-versions "$new_version" gt "$old_version"
  install -m 644 "$newer/work-fold-signing-key.gpg" "$work/key.gpg"
  echo "deb [arch=amd64 signed-by=$work/key.gpg] file:$work/repository/apt stable main" > "$work/source.list"
  mkdir -p "$work/negative-lists/partial" "$work/lifecycle-lists/partial"
  apt_test() { apt-get -o "Dir::State::lists=$work/negative-lists" -o "Dir::Etc::sourcelist=$work/source.list" -o Dir::Etc::sourceparts=- -o APT::Update::Error-Mode=any "$@"; }
  # Keep Ubuntu's normal authenticated repositories available for new runtime
  # dependencies during upgrades. Negative tests use a separate, isolated cache.
  apt_lifecycle() { apt-get -o "Dir::State::lists=$work/lifecycle-lists" -o "Dir::Etc::sourcelist=$work/source.list" -o APT::Update::Error-Mode=any "$@"; }
  switch_repo "$newer"
  # A signed file whose text changed must fail before it supplies package indexes.
  sed -i 's/Origin: work-fold/Origin: altered/' "$work/repository/apt/dists/stable/InRelease"
  expect_failure 'BADSIG|invalid signature' apt_test update
  switch_repo "$newer"
  cp "$work/key.gpg" "$work/correct-key.gpg"
  cp /usr/share/keyrings/ubuntu-archive-keyring.gpg "$work/key.gpg"
  expect_failure 'NO_PUBKEY|not signed|not available' apt_test update
  cp "$work/correct-key.gpg" "$work/key.gpg"
  apt_test update
  find "$work/repository/apt/pool" -name '*.deb' -exec sh -c 'printf tampered >> "$1"' _ {} \;
  (cd "$work"; expect_failure 'Hash Sum mismatch|unexpected size' apt_test download "work-fold-desktop=$new_version")
  # Negative tests have already fetched the newer signed Date. Give the
  # independent old-to-new lifecycle its own repository URL/cache identity;
  # APT intentionally ignores an older signed Release at an existing URL.
  repository="$work/lifecycle"
  echo "deb [arch=amd64 signed-by=$work/key.gpg] file:$repository/apt stable main" > "$work/source.list"
  node -e 'const fs=require("fs");const dates=process.argv.slice(1).map(p=>Date.parse(fs.readFileSync(p+"/apt/dists/stable/Release","utf8").match(/^Date: (.+)$/m)[1])); if(dates[1]<=dates[0]) throw Error("Stage the newer signed Release after the older one");' "$older" "$newer"
  switch_repo "$older"
  apt_lifecycle update
  apt_lifecycle install -y "work-fold-desktop=$old_version"
  smoke seed "$old_version"
  switch_repo "$newer"
  apt_lifecycle update
  apt_lifecycle install -y --only-upgrade "work-fold-desktop=$new_version"
  test "$(dpkg-query -W -f='${Version}' work-fold-desktop)" = "$new_version"
  smoke verify "$new_version"
  apt_lifecycle remove -y work-fold-desktop
  apt_lifecycle install -y "work-fold-desktop=$new_version"
  smoke verify "$new_version"
  apt_lifecycle purge -y work-fold-desktop
elif test "$kind" = rpm; then
  smoke_user=smoke
  profile=/home/smoke/workfold-signed-install
  credentials=/home/smoke/workfold-signed-credentials
  switch_repo "$newer"
  install -m 644 "$newer/work-fold-signing-key.asc" "$work/key.asc"
  cat > /etc/yum.repos.d/workfold-test.repo <<EOF
[workfold-test]
name=work-fold disposable signed repository acceptance
baseurl=file://$work/repository/rpm/x86_64
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file://$work/key.asc
skip_if_unavailable=0
metadata_expire=0
EOF
  dnf_test() { dnf -y --disablerepo='*' --enablerepo=workfold-test "$@"; }
  sed -i 's/<revision>/<revision>altered/' "$work/repository/rpm/x86_64/repodata/repomd.xml"
  expect_failure 'signature|GPG|OpenPGP' dnf_test makecache --refresh
  switch_repo "$older"
  dnf clean all
  # The normal Fedora repositories supply dependencies; our repository requires
  # both metadata and package signatures throughout installation and upgrade.
  dnf install -y "work-fold-desktop-$old_version"
  smoke seed "$old_version"
  switch_repo "$newer"
  dnf clean all
  dnf upgrade -y work-fold-desktop
  test "$(rpm -q --qf '%{VERSION}' work-fold-desktop)" = "$new_version"
  smoke verify "$new_version"
  dnf remove -y work-fold-desktop
  dnf install -y "work-fold-desktop-$new_version"
  smoke verify "$new_version"
  dnf remove -y work-fold-desktop
  dnf clean all
  find "$work/repository/rpm/x86_64/Packages" -name '*.rpm' -exec sh -c 'printf tampered >> "$1"' _ {} \;
  expect_failure 'checksum|size|digest' dnf install -y "work-fold-desktop-$new_version"
  test ! -e /opt/work-fold/work-fold-desktop
  rm /etc/yum.repos.d/workfold-test.repo
else
  echo 'Choose apt or rpm' >&2
  exit 1
fi
echo "PASS signed $kind repository: install, real version upgrade, remove/reinstall, preserved Pi/Chat/History/Library/request and credentials, tamper rejection"
