// Loads runtime config from Azure App Configuration + Key Vault at startup.
// Workload identity: the pod's ServiceAccount is federated to
// house-hunt-identity (tofu/identity.tf) with narrow KV + App Config +
// Storage Blob + Azure Maps grants.
import { AppConfigurationClient } from '@azure/app-configuration';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

export async function fetchConfig() {
  const appConfigEndpoint = process.env.AZURE_APP_CONFIG_ENDPOINT;
  const keyVaultUrl = process.env.KEY_VAULT_URL;
  if (!appConfigEndpoint) throw new Error('AZURE_APP_CONFIG_ENDPOINT unset');
  if (!keyVaultUrl) throw new Error('KEY_VAULT_URL unset');

  const credential = new DefaultAzureCredential();
  const appConfig = new AppConfigurationClient(appConfigEndpoint, credential);
  const kv = new SecretClient(keyVaultUrl, credential);

  const storageEndpoint = await appConfig.getConfigurationSetting({ key: 'househunt/storage_account_endpoint' });

  // Per-app signing secret. Microsoft sign-in happens upstream at
  // auth.romaine.life — this secret only signs house-hunt's own session JWTs
  // (minted at /api/auth/exchange after we've verified the upstream JWT).
  const jwtSigningSecret = (await kv.getSecret('house-hunt-jwt-signing-secret')).value;

  return {
    storageAccountEndpoint: storageEndpoint.value,
    jwtSigningSecret,
  };
}
