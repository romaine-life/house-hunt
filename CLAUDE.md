# house-hunt

Map-based property tracker at househunt.romaine.life. Public visitors see an Azure Maps dark-themed map with pins. Nelson logs in via terminal-minted JWT to manage properties.

## Auth

Terminal-minted JWTs — identical to my-homepage. The `at` command mints a 30-day JWT, exchanges it for a one-time code via `POST /auth/code`, and opens the browser at `/auth/callback?code=...` to set an HttpOnly cookie. No MSAL, no login forms.

- JWT claims: `{ sub, email, name, role, iat, exp }` — signed with `api-jwt-signing-secret` from Key Vault.
- No browser auth fallback — unauthenticated users see the map (public) but no admin controls.
- Local dev port 3003 — frontend on 3003, shared API on 3000.

## Routes Package (`packages/routes/`)

Published as `@nelsong6/house-hunt-routes` to GitHub Packages. CRUD for properties stored in Azure Blob Storage (single `properties.json` blob, versioned). Receives `requireAuth`, `propertiesContainerClient`, and `getMapsToken` via dependency injection from the shared API. Public endpoint `GET /api/properties` has no auth. `GET /maps/token` is also public (map must render for everyone) — returns a short-lived Azure AD token for Azure Maps, cached server-side with 60s buffer. All write endpoints require auth.

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

Static HTML + vanilla JS + Azure Maps SDK (CDN). No build step. Full-screen dark-themed map (`grayscale_dark` style) with a collapsible right sidebar for property list and admin form. Colored bubble markers by status (Catppuccin palette). Geocoding via Azure Maps Search API using the same AD token flow.

## API Endpoints (mounted at `/househunt` on shared API)

- `GET /maps/token` — public, Azure AD token for Azure Maps
- `GET /api/properties` — public, returns all properties + checklist schema
- `POST /api/properties` — admin, add property
- `PUT /api/properties/:id` — admin, update property
- `DELETE /api/properties/:id` — admin, delete property
- `PUT /api/checklist-schema` — admin, update checklist items
- `POST /auth/code` — JWT to one-time code
- `GET /auth/callback` — code to cookie
- `GET /auth/whoami` — identity from cookie
- `GET /auth/logout` — clear cookie

## Publish Pipeline

Triggers on push to `packages/routes/**`. Auto-bumps patch version, publishes to GitHub Packages, dispatches `dependency-updated` to API repo.

## Change Log

### 2026-04-06

- **Initial scaffold** — created the full app: frontend (Azure Maps dark-themed map + Catppuccin sidebar), routes package (auth + blob CRUD + maps token endpoint), and OpenTofu infrastructure (SWA, Blob Storage, Azure Maps account with managed identity auth). Follows the my-homepage pattern for auth (terminal-minted JWT) and data storage (single versioned JSON blob). Azure Maps chosen over Google Maps to avoid external API keys — uses the same OIDC/managed identity pattern as the rest of the infra. Maps account lives in this repo's Terraform (not infra-bootstrap) so it tears down cleanly with the app.
