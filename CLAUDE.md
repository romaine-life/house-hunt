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

### Decentralized Microsoft app registration

Unlike kill-me/investing/plant-agent (which still share infra-bootstrap's `romaine.life - Social Login` registration), house-hunt owns its own Azure AD app registration in `tofu/oauth.tf`. Redirect URIs, client ID, and lifecycle live with this repo. The shared API's `microsoft-routes.js` accepts an array of audiences, populated by enumerating every `*/microsoft_oauth_client_id` key in App Configuration plus the legacy shared `microsoft_oauth_client_id_plain` key. Each app's tofu writes its own client ID under its own prefix; no cross-repo coordination required to add or rotate apps.

The deploy workflow fetches `MICROSOFT_CLIENT_ID` from App Configuration at deploy time (rather than reading a GitHub variable) so the tofu-managed value stays the source of truth.

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
      "starred": true,
      "status": "interested|visited|offer|rejected|closed",
      "listingUrl": "https://...",
      "photoUrl": "https://rmlsweb.com/webphotos/.../MLS-1-a.jpg",
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

Static HTML + vanilla JS + Azure Maps SDK (CDN). No build step. Hosted on **Azure Static Web App** (Standard tier, `house-hunt-app` in `house-hunt-rg`). Full-screen dark-themed map (`night` style) with a collapsible right sidebar for property list and admin form. Pin markers via SymbolLayer with canvas-generated icons per status color (fixed pixel size at all zoom levels). Geocoding via Azure Maps Search API with `x-ms-client-id` header. RMLS link lookup auto-fills address, metadata, and listing photo.

Map popup features: clickable Google Maps address link, MLS# links to Google search, interactive checklist checkboxes (admin-toggleable, disabled for viewers), star/favorite toggle, Edit and Delete buttons for admins. Clicking empty map area dismisses popup. Sidebar has star filter toggle to show only starred properties. Bulk select + delete: admin toggle button or Shift-hold enters selection mode (disables map panning, crosshair cursor), click-drag draws rectangle to select pins inside it, click individual pins to toggle. Selected pins render with white outline via `pin-selected-{status}` sprites. Sidebar shows checkboxes on cards and selection bar with count/All/None/Delete buttons. Escape clears selection.

Deploy workflow uses `Azure/static-web-apps-deploy@v1` with SWA deployment token fetched via OIDC. `MAPS_CLIENT_ID` and `MICROSOFT_CLIENT_ID` are GitHub Actions variables — no Azure login needed for config generation. DNS CNAME managed in `tofu/frontend.tf` points `househunt.romaine.life` to the SWA default hostname.

## Import Scripts (`scripts/`)

- `fetch-rmls.py` — Fetch an RMLS complete list page to local HTML for parsing
- `import-rmls.py` — Full pipeline: fetch or read local RMLS HTML, parse listings (extracts lat/lon from embedded `MGS_ShowMap_Ex` JS — no geocoding needed), deduplicate against blob storage, generate photo URLs, upload. Supports `--dry-run` and local file input.
- `extract-rmls-links.py` — Search privateemail IMAP for RMLS report links
- `extract-redfin-links.py` — Search privateemail IMAP for Redfin property links

## API Endpoints (mounted at `/househunt` on shared API)

- `GET /maps/token` — public, Azure AD token for Azure Maps
- `POST /api/rmls-lookup` — public, scrapes RMLS public report URL for address, price, metadata, photo
- `GET /api/properties` — public, returns all properties + checklist schema
- `POST /api/properties` — admin, add property
- `PUT /api/properties/:id` — admin, update property
- `DELETE /api/properties/:id` — admin, delete property
- `DELETE /api/properties` — admin, bulk delete properties (body: `{ ids, lastKnownVersion }`)
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
- **Map style switched from grayscale_dark to night** — grayscale looked black and white. Night theme has colored roads, water, and parks on a dark background.
- **RMLS link scraper** — paste an rmlsweb.com public report link, backend scrapes address (from MAPLINK_ADDRESS_FULL class), price, beds/baths/sqft (from BED_BATH summary span), year built, lot size, garage, HOA dues, property type/style, and listing photo (from PHOTO_NEW img tag). Auto-geocodes the address onto the map. Replaced the Redfin MLS# lookup which couldn't find listings.
- **Pin markers via SymbolLayer** — replaced BubbleLayer (scaled with zoom, invisible at metro level) with canvas-generated pin icons registered in the map's image sprite. Fixed pixel size at all zoom levels. `allowOverlap` + `ignorePlacement` prevent culling.
- **Fixed pin race condition** — `renderProperties()` ran before the map `ready` event created the datasource. Added re-render call inside the ready handler.
- **Capped fitBounds maxZoom to 14** — single-point bounds zoomed to max. Now caps at neighborhood level.
- **Listing photo in popup** — main RMLS photo shown at top of pin popup (140px, cover-fit). Stored as `photoUrl` in property data.
- **Local dev role assignments** — added Nelson's personal Azure identity as Storage Blob Data Contributor and Azure Maps Data Reader so the local API can access blob storage and mint maps tokens. Added CORS allowed origins to the Maps account.

### 2026-04-09

- **Migrated frontend from GitHub Pages to Azure SWA Standard tier** — GitHub Pages was fragile (CNAME deletions, gh-pages branch management, OIDC mismatches with environments). SWA resource, DNS CNAME, and custom domain all managed in tofu. Deploy workflow simplified: no Azure login needed for config (MAPS_CLIENT_ID moved to GitHub variable), uses `Azure/static-web-apps-deploy@v1` with deployment token.
- **Eliminated gh-pages branch entirely** — first switched to `actions/deploy-pages` (workflow-based GitHub Pages), then moved to SWA. Deleted the gh-pages branch and removed `app_pages_branch` from infra-bootstrap.
- **Bulk imported 88 RMLS listings** — built `scripts/fetch-rmls.py` to dump RMLS pages locally (WebFetch hangs on large RMLS pages), then parsed HTML for addresses, MLS numbers, prices, sqft. Geocoded via Azure Maps, constructed photo URLs from MLS number directory pattern, uploaded to blob storage. Deduplication against existing properties.
- **Popup UX overhaul** — address links to Google Maps, MLS# links to Google search, interactive checklist checkboxes (save immediately for admins, disabled for viewers), star/favorite toggle, Edit and Delete buttons in popup for admins. Click empty map to dismiss popup. Close button restyled for visibility.
- **Star/favorite feature** — admins can star properties from popup. Sidebar header has filter toggle between all/starred view. Starred properties show gold star in sidebar cards. Filter hides non-starred pins from map.
- **Map behavior fixes** — removed zoom-on-click for sidebar cards (just pans now), fixed fitMapToData only running on initial load instead of every re-render, fixed pin click vs map click event ordering.
- **Added house favicon** (blue SVG).
- **Added Microsoft MSAL redirect URI** for `househunt.romaine.life` on the Azure AD app registration (SWA domain wasn't registered after migration from GitHub Pages).

### 2026-04-12

- **Bulk select + delete** — admin-only rectangle drag-select on the map for bulk property deletion. Toggle selection mode via "Select" button in sidebar or hold Shift. Draw a rectangle to select pins inside it; click individual pins to toggle selection. Sidebar shows checkboxes and selection count bar with All/None/Delete buttons. Selected pins render with white outline via `pin-selected-{status}` icon sprites. New `DELETE /api/properties` bulk endpoint performs single blob read-modify-write for all IDs at once. Escape clears selection. Star filter change clears selection.
- **Improved RMLS import script** — rewrote `scripts/import-rmls.py` parser to match actual RMLS HTML format: extracts lat/lon directly from `MGS_ShowMap_Ex` JavaScript calls (eliminates geocoding step entirely), parses `BED_BATH` and `PRICE` spans, reads photo directory from `photourls` JavaScript. Accepts local HTML files. Added `--dry-run` mode, progress output, `shell=True` for Windows `az.cmd` compatibility. Imported 122 new listings (210 total).
