#!/bin/sh
# Double-click this file to start OTP Bridge on a Mac (or run it in Terminal).

cd "$(dirname "$0")" || exit 1

# Windows opened from Finder do not always know where Node.js was installed.
find_node() {
  command -v node >/dev/null 2>&1 && return 0
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.nodenv/shims" "$HOME/.asdf/shims" \
    "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/Library/Application Support/fnm/aliases/default/bin"; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done
  # nvm keeps every version in its own folder; use the last one listed.
  found=""
  for dir in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$dir/node" ] && found="$dir"
  done
  if [ -n "$found" ]; then
    PATH="$found:$PATH"
    export PATH
    return 0
  fi
  return 1
}

if ! find_node; then
  echo "OTP Bridge needs Node.js, and it was not found on this Mac."
  echo "Install the LTS version from https://nodejs.org, then open this file again."
  echo
  printf "Press Return to close. "
  read -r _
  exit 1
fi

exec node companion/cli.js "$@"
