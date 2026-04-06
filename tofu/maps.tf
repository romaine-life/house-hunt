# ============================================================================
# Azure Maps — Map rendering and geocoding
# ============================================================================
# S0 (free) tier provides 250k annual tile transactions and 5k geocode calls.
# Frontend authenticates via Azure AD tokens fetched from the API's /maps/token
# endpoint. No API key — the shared API's managed identity gets "Azure Maps
# Data Reader" and mints short-lived tokens for the browser.

resource "azurerm_maps_account" "house_hunt" {
  name                = "house-hunt-maps"
  resource_group_name = azurerm_resource_group.house_hunt.name
  location            = azurerm_resource_group.house_hunt.location
  sku_name            = "G2"
}

# Grant shared API's managed identity read access to Azure Maps
resource "azurerm_role_assignment" "shared_api_maps_reader" {
  scope                = azurerm_maps_account.house_hunt.id
  role_definition_name = "Azure Maps Data Reader"
  principal_id         = "ae41eca7-9819-4028-8690-91a92e494893" # shared-api system-assigned identity
}
