#!/bin/bash
# Installs the "Agents Office" launcher app, so Spotlight and Finder can start the fork's dev
# server (with the fork plugins) and open the office in the default browser.
#
# Usage:
#   scripts/install-launcher.sh [dest-dir]
#
# dest-dir defaults to ~/Applications (created if missing). Rerun this script any time after
# a `git pull`, or after moving the clone, to rebuild the launcher with the current repo path.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dest_dir="${1:-$HOME/Applications}"

"$script_dir/build-launcher-app.sh" "$repo_root" "$dest_dir"
node "$script_dir/launcher/ensure-config-cli.mjs"

# Refreshes Launch Services so Spotlight indexes the app without a reboot or a log out.
# Best-effort: a failure here still leaves a working app, just not yet Spotlight-searchable.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$dest_dir/Agents Office.app" >/dev/null 2>&1 || true

cat <<MSG

Installed: $dest_dir/Agents Office.app
Config:    $HOME/Library/Application Support/AgentsOffice/launcher.env
           (edit to set mission roots, GitHub repos or a portrait image; see the file's comments)
Logs:      $HOME/Library/Logs/agents-office/launcher.log

Open "Agents Office" from Spotlight or Applications to start the server and open the office.
MSG
