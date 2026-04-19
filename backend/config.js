// Loads runtime config from Azure App Configuration + Key Vault at startup.
// Workload identity: the pod's ServiceAccount is federated to the shared
// managed identity (infra-shared-identity) which has App Config Data Reader,
// Key Vault Secrets User, and Storage Blob Data Contributor roles.
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

  const cosmosEndpoint = await appConfig.getConfigurationSetting({ key: 'cosmos_db_endpoint' });
  const storageEndpoint = await appConfig.getConfigurationSetting({ key: 'househunt/storage_account_endpoint' });

  // Accept tokens from every Microsoft OAuth app registration — same
  // enumeration logic as the shared api. App Configuration wildcards are
  // trailing-only, so filter client-side for `*/microsoft_oauth_client_id`.
  const microsoftClientIds = [];
  const sharedMs = await appConfig
    .getConfigurationSetting({ key: 'microsoft_oauth_client_id_plain' })
    .catch(() => null);
  if (sharedMs?.value) microsoftClientIds.push(sharedMs.value);
  for await (const setting of appConfig.listConfigurationSettings()) {
    if (
      setting.key?.endsWith('/microsoft_oauth_client_id') &&
      setting.value &&
      !microsoftClientIds.includes(setting.value)
    ) {
      microsoftClientIds.push(setting.value);
    }
  }
  if (!microsoftClientIds.length) {
    throw new Error('No Microsoft OAuth client IDs found in App Configuration.');
  }

  const jwtSigningSecret = (await kv.getSecret('api-jwt-signing-secret')).value;

  return {
    cosmosDbEndpoint: cosmosEndpoint.value,
    storageAccountEndpoint: storageEndpoint.value,
    jwtSigningSecret,
    microsoftClientIds,
  };
}
