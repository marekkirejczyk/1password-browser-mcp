#!/usr/bin/env bash
# Turns this Mac into the self-hosted GitHub Actions runner for the e2e workflow and stores the 1Password
# service account token in its login keychain. Run it once, from a Terminal of the user that stays logged
# in on this machine (the runner is installed as a LaunchAgent in that user's session, which is what gives
# it an unlocked login keychain and a display for Chrome).
#
#   RUNNER_TOKEN=<registration token> scripts/setup-runner.sh
#
# The registration token comes from GitHub: repository Settings > Actions > Runners > New self-hosted
# runner (it expires after an hour). With the gh CLI signed in you can leave RUNNER_TOKEN unset and the
# script fetches one. The 1Password token is asked for interactively and never echoed or written to disk
# outside the keychain. Nothing here needs sudo.
set -euo pipefail

REPO="${REPO:-marekkirejczyk/1password-browser-mcp}"
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-browser-mcp}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-browser-mcp-op-service-account}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this script is for macOS"
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || die "install Google Chrome first"
command -v node >/dev/null || die "install Node 20+ first (brew install node); the runner captures this shell's PATH"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node 20+ is required, found $(node --version)"

say "1Password service account token -> login keychain ($KEYCHAIN_SERVICE)"
if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  echo "already stored; leaving it alone (delete with: security delete-generic-password -s $KEYCHAIN_SERVICE)"
else
  printf 'Paste the service account token (input hidden): '
  read -rs OP_TOKEN; echo
  [[ "$OP_TOKEN" == ops_* ]] || die "that does not look like a service account token (expected ops_...)"
  security add-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w "$OP_TOKEN"
  unset OP_TOKEN
  echo "stored"
fi

say "GitHub runner registration token"
if [ -z "${RUNNER_TOKEN:-}" ]; then
  command -v gh >/dev/null || die "set RUNNER_TOKEN (Settings > Actions > Runners > New self-hosted runner) or install and sign in to gh"
  RUNNER_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)"
fi

say "Downloading the runner into $RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
if [ ! -x ./config.sh ]; then
  arch="$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)"
  if command -v gh >/dev/null; then
    gh release download -R actions/runner --pattern "actions-runner-osx-${arch}-*.tar.gz" --output runner.tar.gz --clobber
  else
    ver="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
    curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${ver}/actions-runner-osx-${arch}-${ver}.tar.gz"
  fi
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

say "Registering with github.com/$REPO"
./config.sh --unattended --replace --url "https://github.com/$REPO" --token "$RUNNER_TOKEN" \
  --name "$(scutil --get ComputerName | tr ' ' '-')" --labels "$RUNNER_LABELS" --work _work

say "Installing as a LaunchAgent (starts at login, runs in your session)"
./svc.sh install
./svc.sh start
./svc.sh status || true

cat <<MSG

Done. Keep this user logged in (System Settings > Users & Groups > automatic login, and no sleep under
Energy). The first job may show a keychain dialog asking to allow "security" to read the token: choose
Always Allow. Check the runner at https://github.com/$REPO/settings/actions/runners
MSG
