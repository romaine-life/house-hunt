resource "random_password" "jwt_signing_secret" {
  length  = 64
  special = false
}

# Per-app HS256 signing secret for backend/auth-routes.js's MintSession.
# Microsoft sign-in happens upstream at auth.romaine.life; this secret
# only signs house-hunt's own session JWTs.
resource "azurerm_key_vault_secret" "jwt_signing_secret" {
  name         = "house-hunt-jwt-signing-secret"
  value        = random_password.jwt_signing_secret.result
  key_vault_id = data.azurerm_key_vault.main.id
}
