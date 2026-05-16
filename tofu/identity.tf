# Per-app workload identity for house-hunt — replaces reuse of
# infra-shared-identity. Scoped to what backend/server.js + config.js
# actually call:
#   - KV Secrets User on house-hunt-jwt-signing-secret (HS256 session
#     signer; Microsoft sign-in itself moved to auth.romaine.life)
#   - App Configuration Data Reader at store level — config.js reads
#     househunt/storage_account_endpoint
#   - Storage Blob Data Contributor on the `properties` container in
#     `househuntdata`
#   - Azure Maps Data Reader on the `house-hunt-maps` account (mints
#     short-lived tokens via /maps/token)

data "azurerm_resource_group" "infra" {
  name = local.infra.resource_group_name
}

data "azurerm_kubernetes_cluster" "infra" {
  name                = "infra-aks"
  resource_group_name = local.infra.resource_group_name
}

data "azurerm_key_vault" "main" {
  name                = local.infra.key_vault_name
  resource_group_name = local.infra.resource_group_name
}

resource "azurerm_user_assigned_identity" "house_hunt" {
  name                = "house-hunt-identity"
  resource_group_name = data.azurerm_resource_group.infra.name
  location            = data.azurerm_resource_group.infra.location
}

resource "azurerm_role_assignment" "house_hunt_kv_jwt_secret" {
  scope                = "${data.azurerm_key_vault.main.id}/secrets/house-hunt-jwt-signing-secret"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.house_hunt.principal_id
}

resource "azurerm_role_assignment" "house_hunt_appconfig" {
  scope                = local.infra.azure_app_config_resource_id
  role_definition_name = "App Configuration Data Reader"
  principal_id         = azurerm_user_assigned_identity.house_hunt.principal_id
}

# Container-scoped, not account-scoped — narrows past the existing
# `shared_api_storage_contributor` (account scope, decommissioned identity)
# and `shared_identity_storage` (subscription scope on infra-shared).
resource "azurerm_role_assignment" "house_hunt_properties_blob" {
  scope                = azurerm_storage_container.properties.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.house_hunt.principal_id
}

resource "azurerm_role_assignment" "house_hunt_maps_reader" {
  scope                = azurerm_maps_account.house_hunt.id
  role_definition_name = "Azure Maps Data Reader"
  principal_id         = azurerm_user_assigned_identity.house_hunt.principal_id
}

resource "azurerm_federated_identity_credential" "house_hunt" {
  name                = "aks-house-hunt"
  resource_group_name = local.infra.resource_group_name
  parent_id           = azurerm_user_assigned_identity.house_hunt.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = data.azurerm_kubernetes_cluster.infra.oidc_issuer_url
  subject             = "system:serviceaccount:house-hunt:infra-shared"
}

output "house_hunt_identity_client_id" {
  value       = azurerm_user_assigned_identity.house_hunt.client_id
  description = "Pin into k8s/serviceaccount.yaml's azure.workload.identity/client-id annotation."
}
