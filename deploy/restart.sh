#!/usr/bin/env bash
set -euo pipefail
exec sudo -n /usr/bin/systemctl restart greece-dance.service
