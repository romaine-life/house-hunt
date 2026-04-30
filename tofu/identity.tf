# Per-app workload identity for house-hunt — replaces reuse of
# infra-shared-identity. Scoped to what backend/server.js + config.js
# actually call:
#   - Cosmos data on dbs/WorkoutTrackerDB (the DB house-hunt's pod
#     queries for `account` records during MS-OIDC → JWT exchange;
#     same shared-tenancy DB kill-me writes account records into)
#   - KV Secrets User on api-jwt-signing-secret
#   - App Configuration Data Reader at store level (config.js calls
#     listConfigurationSettings to enumerate `*/microsoft_oauth_client_id`)
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

# remote-state.tf still references the decommissioned `infra-cosmos`
# account; house-hunt's runtime reads from `infra-cosmos-serverless`
# via the App Config key. Hardcode the live account here so the
# identity scopes at the actual data plane.
data "azurerm_cosmosdb_account" "live" {
  name                = "infra-cosmos-serverless"
  resource_group_name = local.infra.resource_group_name
}

resource "azurerm_user_assigned_identity" "house_hunt" {
  name                = "house-hunt-identity"
  resource_group_name = data.azurerm_resource_group.infra.name
  location            = data.azurerm_resource_group.infra.location
}

resource "azurerm_cosmosdb_sql_role_assignment" "house_hunt_cosmos" {
  resource_group_name = local.infra.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.live.name
  role_definition_id  = "${data.azurerm_cosmosdb_account.live.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_user_assigned_identity.house_hunt.principal_id
  # `<account>/dbs/<name>`, NOT the ARM resource ID — Cosmos data plane
  # rejects ARM-format scopes ("Expected path segment [dbs] at position
  # [0] but found [sqlDatabases]").
  scope               = "${data.azurerm_cosmosdb_account.live.id}/dbs/WorkoutTrackerDB"
}

resource "azurerm_role_assignment" "house_hunt_kv_jwt_secret" {
  scope                = "${data.azurerm_key_vault.main.id}/secrets/api-jwt-signing-secret"
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
