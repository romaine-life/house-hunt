resource "azurerm_static_web_app" "house_hunt" {
  name                = "house-hunt-app"
  resource_group_name = azurerm_resource_group.house_hunt.name
  location            = azurerm_resource_group.house_hunt.location
  sku_tier            = "Free"
  sku_size            = "Free"
  lifecycle {
    ignore_changes = [
      repository_url,
      repository_branch
    ]
  }
}

locals {
  front_app_dns_name = "househunt"
}

resource "azurerm_dns_cname_record" "house_hunt" {
  name                = local.front_app_dns_name
  zone_name           = local.infra.dns_zone_name
  resource_group_name = local.infra.resource_group_name
  ttl                 = 3600
  record              = azurerm_static_web_app.house_hunt.default_host_name
}

resource "azurerm_static_web_app_custom_domain" "house_hunt" {
  static_web_app_id = azurerm_static_web_app.house_hunt.id
  domain_name       = "${local.front_app_dns_name}.${local.infra.dns_zone_name}"
  validation_type   = "cname-delegation"
  depends_on        = [azurerm_dns_cname_record.house_hunt]
}
