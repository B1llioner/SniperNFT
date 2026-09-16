#!/usr/bin/env bash
# Explicit public profile. The checked shared installer must accompany this file.
set -euo pipefail
umask 077
directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec bash "$directory/install-genesis-check.sh" --public "$@"
