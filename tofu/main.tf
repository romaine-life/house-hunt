resource "azurerm_resource_group" "house_hunt" {
  name     = "house-hunt-rg"
  location = var.location
}

# App identity used for hostname (househunt.romaine.life), App Configuration
# key prefix, and the MS OAuth redirect URI. One source of truth so renaming
# the app's external identity is a one-line change.
locals {
  front_app_dns_name = "househunt"
}
