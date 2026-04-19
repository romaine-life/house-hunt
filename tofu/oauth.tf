# ============================================================================
# Microsoft "Sign in with Microsoft" — house-hunt only
# ============================================================================
# Decentralized from infra-bootstrap's shared social-login app registration so
# this app owns its own redirect URIs. The shared API loads every per-app
# `*/microsoft_oauth_client_id` value from App Configuration and validates
# tokens against the union of audiences.

data "azuread_client_config" "current" {}

resource "azuread_application" "microsoft_login" {
  display_name     = "house-hunt - Social Login"
  sign_in_audience = "AzureADandPersonalMicrosoftAccount"

  # Tofu's executing SP must be an owner to update this app (redirect URIs
  # etc.) — `Application.ReadWrite.OwnedBy` only works for owned apps. The
  # app was historically created without an owner entry; fixed manually once
  # and declared here so future apply runs re-assert it.
  owners = [data.azuread_client_config.current.object_id]

  api {
    requested_access_token_version = 2
  }

  single_page_application {
    redirect_uris = [
      "https://househunt.romaine.life/",
      # Local dev — backend serves frontend + API on same origin at :3000.
      "http://localhost:3000/",
    ]
  }
}

# Publish the client ID under a per-app key so the shared API can discover it
# alongside other apps' client IDs by listing keys matching `*/microsoft_oauth_client_id`.
resource "azurerm_app_configuration_key" "microsoft_oauth_client_id" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "househunt/microsoft_oauth_client_id"
  value                  = azuread_application.microsoft_login.client_id
}
