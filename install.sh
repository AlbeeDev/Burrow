#!/bin/sh
# Burrow installer.
#
# Plain POSIX sh, on purpose: this is the only entry point that runs on a machine with no Node at
# all. `npm install` cannot report that Node is missing, because npm IS Node, on a fresh WSL box
# the first command of the install died with `exec: node: not found`, which says nothing about
# what to do. Everything past the check below is Node's job; this file exists for the ten seconds
# before that is true.
#
#   ./install.sh
#
set -eu

NODE_MIN=20

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  # The WSL variant of this is worth naming: `npm` resolves to the WINDOWS install through PATH
  # interop while `node` does not, so the machine looks half-equipped rather than empty.
  if command -v npm >/dev/null 2>&1 && case "$(command -v npm)" in /mnt/c/*) true ;; *) false ;; esac; then
    die "npm here is the Windows one ($(command -v npm)) and there is no node inside WSL.
Install Node inside WSL: it takes precedence once present:

  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  exec bash && nvm install 22"
  fi
  die "Node is not installed, and Burrow's installer is written in it.

  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  exec bash && nvm install 22

Any Node $NODE_MIN+ will do: nvm just avoids needing sudo for the global installs later."
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$MAJOR" -lt "$NODE_MIN" ]; then
  die "Node $(node -v) is too old: Burrow needs $NODE_MIN or newer.

  nvm install 22"
fi

say "Node $(node -v): handing over to npm."
exec npm install
