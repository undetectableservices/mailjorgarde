#!/usr/bin/env bash
# Compatibility entry point. The idempotent installer/service controller is
# run.sh; it copies a root-owned release to /opt before installing systemd.
set -euo pipefail
cd "$(dirname "$0")"
exec /bin/bash ./run.sh "$@"
