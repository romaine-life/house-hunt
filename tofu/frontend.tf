# DNS CNAME for GitHub Pages custom domain
locals {
  front_app_dns_name = "househunt"
}

resource "azurerm_dns_cname_record" "house_hunt" {
  name                = local.front_app_dns_name
  zone_name           = local.infra.dns_zone_name
  resource_group_name = local.infra.resource_group_name
  ttl                 = 3600
  record              = "nelsong6.github.io"
}
