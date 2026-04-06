output "resource_group_name" {
  value = azurerm_resource_group.house_hunt.name
}

output "storage_account_name" {
  value = azurerm_storage_account.house_hunt.name
}

output "storage_endpoint" {
  value = azurerm_storage_account.house_hunt.primary_blob_endpoint
}

output "maps_client_id" {
  value = azurerm_maps_account.house_hunt.x_ms_client_id
}
