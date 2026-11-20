# find_node: resolves a usable `node` binary even under the minimal PATH an app launched
# from Spotlight or Finder gets. Sourced into the generated launcher script
# (scripts/build-launcher-app.sh splices this file's bytes into the heredoc there, so there
# is one source of truth) and sourced directly by tests/launcher-build.test.ts, which stubs
# HOME and calls the nvm helpers in isolation, without the hardcoded Homebrew/Volta paths
# (real, machine-specific paths that a test cannot safely erase) ever getting in the way.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Apps launched from Spotlight/Finder get a minimal PATH, so common install locations are
  # checked by hand.
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  candidate="$(nvm_default_node)"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  candidate="$(highest_installed_nvm_node)"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

# nvm: the version the user set as default, resolved through at most one alias indirection
# (default commonly points at an alias like lts/* rather than a version number directly). A
# default set to a bare major ("22") has no exact folder of its own: nvm installs full
# versions (v22.15.0), so this resolves to the highest installed patch within that major.
# Prints the node path and returns 0 on a match, prints nothing and returns 1 otherwise.
nvm_default_node() {
  local nvm_dir="$HOME/.nvm"
  [ -f "$nvm_dir/alias/default" ] || return 1
  local default_alias
  default_alias="$(cat "$nvm_dir/alias/default" 2>/dev/null || true)"
  if [ -n "$default_alias" ] && [ -f "$nvm_dir/alias/$default_alias" ]; then
    default_alias="$(cat "$nvm_dir/alias/$default_alias" 2>/dev/null || true)"
  fi
  [ -n "$default_alias" ] || return 1

  local candidate
  case "$default_alias" in
    v*) candidate="$nvm_dir/versions/node/$default_alias/bin/node" ;;
    *) candidate="$nvm_dir/versions/node/v$default_alias/bin/node" ;;
  esac
  if [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi

  local major
  case "$default_alias" in
    v*) major="${default_alias#v}" ;;
    *) major="$default_alias" ;;
  esac
  case "$major" in
    *[!0-9]*) return 1 ;; # not a bare integer (already a full x.y.z, or a codename): no major fallback
  esac
  local highest_of_major
  highest_of_major="$(ls -d "$nvm_dir"/versions/node/v"$major".*/ 2>/dev/null | sort -V | tail -n1)"
  if [ -n "$highest_of_major" ] && [ -x "${highest_of_major}bin/node" ]; then
    echo "${highest_of_major}bin/node"
    return 0
  fi
  return 1
}

# No resolvable default: the highest installed version (sort -V, not a plain lexical sort,
# so v9 does not win over v10 or v22).
highest_installed_nvm_node() {
  local nvm_dir="$HOME/.nvm"
  local highest
  highest="$(ls -d "$nvm_dir"/versions/node/*/ 2>/dev/null | sort -V | tail -n1)"
  if [ -n "$highest" ] && [ -x "${highest}bin/node" ]; then
    echo "${highest}bin/node"
    return 0
  fi
  return 1
}
