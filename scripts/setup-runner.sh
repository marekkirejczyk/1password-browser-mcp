#!/usr/bin/env bash
# Turns this Mac into the self-hosted GitHub Actions runner for the e2e workflow and gives it the 1Password
# service account token. Run it once as the user that stays logged in on this machine: the runner is
# installed as a LaunchAgent in that user's session, which is what gives it a display for Chrome.
#
#   RUNNER_TOKEN=<registration token> scripts/setup-runner.sh
#
# The registration token comes from GitHub: repository Settings > Actions > Runners > New self-hosted
# runner (it expires after an hour). With the gh CLI signed in you can leave RUNNER_TOKEN unset and the
# script fetches one. The 1Password token is asked for interactively (or read from OP_SERVICE_ACCOUNT_TOKEN
# when set) and never echoed. From a Terminal on the machine it goes into the login keychain; over SSH the
# keychain is locked, so it goes into the runner's private .env file instead (owner-only; the runner
# exports it to jobs). Node is installed by the workflow itself (setup-node), so only Chrome is required.
# Nothing here needs sudo.
set -euo pipefail

REPO="${REPO:-marekkirejczyk/1password-browser-mcp}"
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner-browser-mcp}"
RUNNER_LABELS="${RUNNER_LABELS:-browser-mcp}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-browser-mcp-op-service-account}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this script is for macOS"
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || die "install Google Chrome first"

say "1Password service account token"
OP_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"
ENV_TOKEN=""
if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  echo "already in the login keychain as $KEYCHAIN_SERVICE; leaving it alone"
else
  if [ -z "$OP_TOKEN" ]; then printf 'Paste the service account token (input hidden): '; read -rs OP_TOKEN; echo; fi
  [[ "$OP_TOKEN" == ops_* ]] || die "that does not look like a service account token (expected ops_...)"
  if security add-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w "$OP_TOKEN" 2>/dev/null; then
    echo "stored in the login keychain as $KEYCHAIN_SERVICE"
  else
    echo "login keychain is locked in this session (SSH?); the token will go into $RUNNER_DIR/.env instead"
    ENV_TOKEN="$OP_TOKEN"
  fi
fi
unset OP_TOKEN

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
  --name "$(scutil --get ComputerName | tr -c 'A-Za-z0-9\n' '-')-browser-mcp" --labels "$RUNNER_LABELS" --work _work
if [ -n "$ENV_TOKEN" ]; then
  (umask 077; printf 'OP_SERVICE_ACCOUNT_TOKEN=%s\n' "$ENV_TOKEN" > .env); chmod 600 .env
  unset ENV_TOKEN
  echo "token written to $RUNNER_DIR/.env (mode 600; the runner exports it to jobs)"
fi

say "Installing as a LaunchAgent (starts at login, runs in your session)"
./svc.sh install
./svc.sh start
./svc.sh status || true

cat <<MSG

Done. Keep this user logged in (System Settings > Users & Groups > automatic login, and no sleep under
Energy). If the token is in the keychain, the first job may show a dialog asking to allow "security" to
read it: choose Always Allow. To move a token from .env into the keychain later, run on this machine's
console: security add-generic-password -a "\$USER" -s $KEYCHAIN_SERVICE -w <token>; then delete .env and
restart the runner (./svc.sh stop && ./svc.sh start). Check the runner at
https://github.com/$REPO/settings/actions/runners
MSG
