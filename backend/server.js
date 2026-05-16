// Per-app backend for househunt.romaine.life. Serves the static frontend,
// the house-hunt route package under /*, and the auth.romaine.life
// delegation exchange under /api/auth/* on the same origin.
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { createHouseHuntRoutes } from './routes/index.js';
import { createRequireAuth } from './auth.js';
import { createAuthRoutes } from './auth-routes.js';
import { fetchConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
const PORT = process.env.PORT || 3000;
let serverReady = false;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

app.use((req, res, next) => {
  if (serverReady || req.path === '/health') return next();
  res.status(503).json({ error: 'Starting' });
});

app.get('/health', (req, res) => {
  if (!serverReady) return res.status(503).json({ status: 'starting' });
  res.json({ status: 'healthy' });
});

async function start() {
  const config = await fetchConfig();

  const credential = new DefaultAzureCredential();

  const blobServiceClient = new BlobServiceClient(config.storageAccountEndpoint, credential);
  const propertiesContainerClient = blobServiceClient.getContainerClient('properties');

  // Azure Maps token callback — workload identity →
  // house-hunt-identity → "Azure Maps Data Reader" on house-hunt-maps.
  const MAPS_SCOPE = 'https://atlas.microsoft.com/.default';
  const getMapsToken = async () => {
    const token = await credential.getToken(MAPS_SCOPE);
    return { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  };

  const requireAuth = createRequireAuth({ jwtSecret: config.jwtSigningSecret });

  app.use(createAuthRoutes({ jwtSecret: config.jwtSigningSecret, requireAuth }));
  app.use(createHouseHuntRoutes({
    requireAuth,
    propertiesContainerClient,
    getMapsToken,
  }));
  app.use(express.static(FRONTEND_DIR));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });

  serverReady = true;
  console.log(`[house-hunt] ready on port ${PORT}`);
}

app.listen(PORT, () => {
  start().catch((err) => {
    console.error('[house-hunt] fatal startup error:', err);
    process.exit(1);
  });
});

export default app;
