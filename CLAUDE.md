# house-hunt

Map-based property tracker at househunt.romaine.life. Public visitors see an Azure Maps dark-themed map with pins. Nelson logs in via Microsoft MSAL.js to manage properties.

## Auth

MSAL.js Microsoft login in the browser — same pattern as kill-me, investing, and plant-agent. Shared `msAuth` middleware mounted at `/househunt` on the API handles token verification and JWT issuance.

- Frontend uses MSAL.js redirect flow with `@azure/msal-browser` CDN.
- Microsoft ID token sent to `POST /househunt/auth/microsoft/login`, verified via JWKS, returns 7-day JWT.
- Admin role: `nelson-devops-project@outlook.com`. All others: viewer.
- Admin API calls use `Authorization: Bearer <token>` header.
- Unauthenticated users see the map (public) but no admin controls.
- Local dev port 3003 — frontend on 3003, shared API on 3000.

## Routes Package (`packages/routes/`)

Published as `@nelsong6/house-hunt-routes` to GitHub Packages. CRUD for properties stored in Azure Blob Storage (single `properties.json` blob, versioned). Receives `requireAuth`, `propertiesContainerClient`, and `getMapsToken` via dependency injection from the shared API. Auth is handled by the shared `msAuth` middleware — the routes package has no auth endpoints. Public endpoint `GET /api/properties` has no auth. `GET /maps/token` is also public (map must render for everyone) — returns a short-lived Azure AD token for Azure Maps, cached server-side with 60s buffer. All write endpoints require auth.

## Storage

Properties live in Azure Blob Storage (`househuntdata` storage account, `properties` container, private, versioned). Single `properties.json` blob contains the full property list and checklist schema. Blob versioning provides automatic change history.

No Cosmos DB — all data is in the one blob.

## Azure Maps

Azure Maps account (`house-hunt-maps`, Gen2) lives in this repo's Terraform — not infra-bootstrap — so it tears down with the app. The shared API's managed identity has "Azure Maps Data Reader" on the account. No API key — the frontend authenticates via Azure AD tokens:

1. Frontend calls `GET /maps/token` (public, no auth)
2. API uses `DefaultAzureCredential` to mint an Azure AD token scoped to `https://atlas.microsoft.com/`
3. Token is passed to the Azure Maps JS SDK's `getToken` callback
4. Server-side caching reuses the token until 60s before expiry

The Maps client ID (`x_ms_client_id`) is injected into `config.js` at deploy time. Geocoding uses the Azure Maps Search API with the same token.

## Data Model

```json
{
  "properties": [
    {
      "id": "uuid",
      "address": "123 Main St, Portland, OR",
      "lat": 45.523,
      "lng": -122.676,
      "notes": "freeform text",
      "checklist": { "grassAccessMainLevel": true, "groundLevelBedroom": false },
      "status": "interested|visited|offer|rejected|closed",
      "listingUrl": "https://...",
      "addedAt": "ISO",
      "updatedAt": "ISO"
    }
  ],
  "checklistSchema": [
    { "key": "grassAccessMainLevel", "label": "Dog has grass access from main level" },
    { "key": "groundLevelBedroom", "label": "Ground-level bedroom" }
  ]
}
```

Checklist schema is admin-editable via `PUT /api/checklist-schema`.

## Frontend

Static HTML + vanilla JS + Azure Maps SDK (CDN). No build step. Hosted on **GitHub Pages** (not Azure SWA — free tier quota exhausted on the subscription). Full-screen dark-themed map (`grayscale_dark` style) with a collapsible right sidebar for property list and admin form. Colored bubble markers by status (Catppuccin palette). Geocoding via Azure Maps Search API using the same AD token flow.

Deploy workflow pushes to `gh-pages` branch via `peaceiris/actions-gh-pages`. Still uses Azure OIDC login to fetch the Maps client ID from the Azure Maps account at deploy time. DNS CNAME points `househunt.romaine.life` to `nelsong6.github.io`.

## API Endpoints (mounted at `/househunt` on shared API)

- `GET /maps/token` — public, Azure AD token for Azure Maps
- `GET /api/properties` — public, returns all properties + checklist schema
- `POST /api/properties` — admin, add property
- `PUT /api/properties/:id` — admin, update property
- `DELETE /api/properties/:id` — admin, delete property
- `PUT /api/checklist-schema` — admin, update checklist items
- `POST /auth/microsoft/login` — shared msAuth (verify Microsoft ID token, issue JWT)

## Publish Pipeline

Triggers on push to `packages/routes/**`. Auto-bumps patch version, publishes to GitHub Packages, dispatches `dependency-updated` to API repo.

## Change Log

### 2026-04-06

- **Initial scaffold** — created the full app: frontend (Azure Maps dark-themed map + Catppuccin sidebar), routes package (auth + blob CRUD + maps token endpoint), and OpenTofu infrastructure (Blob Storage, Azure Maps account with managed identity auth). Follows the my-homepage pattern for auth (terminal-minted JWT) and data storage (single versioned JSON blob). Azure Maps chosen over Google Maps to avoid external API keys — uses the same OIDC/managed identity pattern as the rest of the infra. Maps account lives in this repo's Terraform (not infra-bootstrap) so it tears down cleanly with the app.
- **Switched from Azure SWA to GitHub Pages** — hit the free SWA quota on the subscription. GitHub Pages has no limit, supports custom domains with HTTPS, and the frontend is just static files with no Azure-native dependencies. Discussed Google Maps vs Azure Maps vs Leaflet — landed on Azure Maps for zero-key infra-native auth.
- **Full infra rollout** — added `house-hunt` to infra-bootstrap's app module (OIDC, service principal, role assignments). Deployed storage account, Azure Maps account, DNS CNAME, and App Config keys. Mounted `@nelsong6/house-hunt-routes` on the shared API at `/househunt` with blob storage + Azure Maps token callback. Frontend deployed to GitHub Pages at househunt.romaine.life.
- **Switched auth from terminal-minted JWT to MSAL.js browser login** — Nelson wanted browser-based auth, not terminal-minted. Frontend now uses Microsoft MSAL.js redirect flow. Shared `msAuth` middleware mounted at `/househunt`. Removed terminal auth endpoints (pendingCodes, /auth/code, /auth/callback, /auth/whoami, /auth/logout) from routes package. Admin API calls use Bearer token instead of cookies. Added redirect URIs for househunt.romaine.life and localhost:3003 to the Azure AD app registration.
