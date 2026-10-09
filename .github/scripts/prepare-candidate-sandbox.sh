#!/usr/bin/env bash
# Ubuntu's hosted image restricts unprivileged user namespaces by executable.
# Grant the namespace helper its own profile; retain the Bubblewrap filesystem
# boundary and the adversarial verifier/receipt-write assertions.
set -euo pipefail
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
sudo apt-get update
sudo apt-get install -y bubblewrap apparmor
test -x /usr/bin/bwrap
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = 1 ]; then
  sudo tee /etc/apparmor.d/paperclip-candidate-bwrap > /dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile paperclip-candidate-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/paperclip-candidate-bwrap
fi
