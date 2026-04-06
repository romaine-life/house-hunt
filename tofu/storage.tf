# ============================================================================
# Azure Blob Storage — Property Data
# ============================================================================
# Single versioned blob (properties.json) stores all property data.
# The Container App's managed identity gets Contributor access.

resource "azurerm_storage_account" "house_hunt" {
  name                     = "househuntdata"
  resource_group_name      = azurerm_resource_group.house_hunt.name
  location                 = azurerm_resource_group.house_hunt.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  blob_properties {
    versioning_enabled = true
  }
}

resource "azurerm_storage_container" "properties" {
  name                  = "properties"
  storage_account_id    = azurerm_storage_account.house_hunt.id
  container_access_type = "private"
}

# Grant shared API's managed identity write access
resource "azurerm_role_assignment" "shared_api_storage_contributor" {
  scope                = azurerm_storage_account.house_hunt.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = "ae41eca7-9819-4028-8690-91a92e494893" # shared-api system-assigned identity
}

# Grant Nelson's personal identity write access (local dev via az login)
resource "azurerm_role_assignment" "dev_storage_contributor" {
  scope                = azurerm_storage_account.house_hunt.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = "cf57d57d-1411-4f59-b517-e9a8600b140a" # nelson (az login)
}
