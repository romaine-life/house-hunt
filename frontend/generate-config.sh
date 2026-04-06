#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${API_URL:?ERROR: API_URL is not set}"
: "${MAPS_CLIENT_ID:?ERROR: MAPS_CLIENT_ID is not set}"
: "${MICROSOFT_CLIENT_ID:?ERROR: MICROSOFT_CLIENT_ID is not set}"

cat <<EOF > "$SCRIPT_DIR/config.js"
export const CONFIG = {
  apiUrl: "${API_URL}",
  mapsClientId: "${MAPS_CLIENT_ID}",
  microsoftClientId: "${MICROSOFT_CLIENT_ID}",
};
EOF

echo "Generated config.js with API_URL=${API_URL}, MAPS_CLIENT_ID=${MAPS_CLIENT_ID}"
