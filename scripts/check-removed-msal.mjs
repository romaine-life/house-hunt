#!/usr/bin/env node
// Migration guard for the auth.romaine.life delegation cutover.
// Per tank-operator/docs/migration-policy.md: the old MSAL path is deleted
// end-to-end and must not creep back via copy-paste or new code.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ignoredDirs = new Set([
  '.claude',
  '.git',
  '.terraform',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'venv',
]);

const ignoredFiles = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.env',
  '.env.local',
  // frontend/config.js is gitignored and generated at deploy time; per-developer
  // copies may temporarily hold stale microsoftClientId values.
  'config.js',
]);

const ignoredRelativePaths = new Set([
  'scripts/check-removed-msal.mjs',
]);

const blocked = [
  { name: 'MSAL browser package', pattern: /@azure\/msal-browser/ },
  { name: 'MSAL CDN script', pattern: /msal-browser(?:\.min)?\.js/ },
  { name: 'MSAL PublicClientApplication', pattern: /\bPublicClientApplication\b/ },
  { name: 'loginRedirect MSAL flow', pattern: /\bloginRedirect\b/ },
  { name: 'logoutRedirect MSAL flow', pattern: /\blogoutRedirect\b/ },
  { name: 'handleRedirectPromise MSAL flow', pattern: /\bhandleRedirectPromise\b/ },
  { name: 'acquireTokenSilent MSAL flow', pattern: /\bacquireTokenSilent\b/ },
  { name: 'legacy microsoft login route', pattern: /\/auth\/microsoft\/login\b/ },
  { name: 'legacy createMicrosoftRoutes', pattern: /\bcreateMicrosoftRoutes\b/ },
  { name: 'per-app email allowlist', pattern: /\bALLOWED_EMAILS?\b/ },
  { name: 'shared api JWT secret', pattern: /\bapi-jwt-signing-secret\b/ },
  { name: 'frontend MICROSOFT_CLIENT_ID', pattern: /\bMICROSOFT_CLIENT_ID\b/ },
  { name: 'frontend microsoftClientId config', pattern: /microsoftClientId/ },
  { name: 'App Config microsoft client ID key', pattern: /microsoft_oauth_client_id/ },
  { name: 'jwks-rsa Microsoft JWKS client', pattern: /\bjwks-rsa\b/ },
  { name: 'Microsoft login JWKS URL', pattern: /login\.microsoftonline\.com.*discovery/ },
];

const failures = [];

for await (const filePath of walk(repoRoot)) {
  const relativePath = toRepoPath(filePath);
  if (ignoredRelativePaths.has(relativePath)) continue;
  const bytes = await fs.readFile(filePath);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const rule of blocked) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const { line, column } = lineAndColumn(text, match.index);
    failures.push(`${relativePath}:${line}:${column} ${rule.name}: ${JSON.stringify(match[0])}`);
  }
}

if (failures.length > 0) {
  console.error('Retired MSAL/auth surface detected:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('No retired MSAL/auth surfaces found.');

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) yield* walk(absolutePath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredFiles.has(entry.name)) continue;
    yield absolutePath;
  }
}

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r\n|\r|\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}
