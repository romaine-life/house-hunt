#!/bin/bash
# Generates frontend/config.js from environment variables.
# Called by the deploy workflow after Azure Login.

API_URL="${API_URL:-http://localhost:3000/househunt}"
MAPS_CLIENT_ID="${MAPS_CLIENT_ID:-YOUR_MAPS_CLIENT_ID}"

cat > "$(dirname "$0")/config.js" <<EOF
const _isBypass = window.location.hostname.includes('azurestaticapps.net');

export const CONFIG = {
  apiUrl: _isBypass
    ? '${API_URL}'
    : 'http://localhost:3000/househunt',
  mapsClientId: '${MAPS_CLIENT_ID}',
};
EOF

echo "Generated config.js with API_URL=${API_URL}, MAPS_CLIENT_ID=${MAPS_CLIENT_ID}"
