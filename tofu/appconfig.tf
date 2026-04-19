resource "azurerm_app_configuration_key" "storage_endpoint" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/storage_account_endpoint"
  value                  = azurerm_storage_account.house_hunt.primary_blob_endpoint
}

resource "azurerm_app_configuration_key" "maps_client_id" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/maps_client_id"
  value                  = azurerm_maps_account.house_hunt.x_ms_client_id
}
