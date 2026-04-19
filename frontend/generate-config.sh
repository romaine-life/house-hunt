#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${MAPS_CLIENT_ID:?ERROR: MAPS_CLIENT_ID is not set}"
: "${MICROSOFT_CLIENT_ID:?ERROR: MICROSOFT_CLIENT_ID is not set}"

cat <<EOF > "$SCRIPT_DIR/config.js"
export const CONFIG = {
  mapsClientId: "${MAPS_CLIENT_ID}",
  microsoftClientId: "${MICROSOFT_CLIENT_ID}",
};
EOF

echo "Generated config.js with MAPS_CLIENT_ID=${MAPS_CLIENT_ID}"
