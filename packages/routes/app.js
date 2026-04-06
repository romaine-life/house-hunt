import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const BLOB_NAME = 'properties.json';

const EMPTY_DATA = {
  properties: [],
  checklistSchema: [
    { key: 'grassAccessMainLevel', label: 'Dog has grass access from main level' },
    { key: 'groundLevelBedroom', label: 'Ground-level bedroom' },
  ],
};

/**
 * Creates the house-hunt routes as an Express router.
 *
 * @param {{
 *   requireAuth: Function,
 *   propertiesContainerClient: import('@azure/storage-blob').ContainerClient,
 *   jwtSecret: string,
 *   frontendUrl: string,
 *   getMapsToken: () => Promise<{token: string, expiresOnTimestamp: number}>,
 * }} opts
 */
export function createHouseHuntRoutes({ requireAuth, propertiesContainerClient, jwtSecret, frontendUrl, getMapsToken }) {
  const router = Router();

  // ── One-time code store (in-memory, short-lived) ────────────────
  const pendingCodes = new Map();
  const CODE_TTL_MS = 30_000;

  // Health check
  router.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── Azure Maps token (public — map must render for everyone) ────

  let cachedToken = null;

  router.get('/maps/token', async (_req, res) => {
    try {
      // Reuse token if it has >60s remaining
      if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 60_000) {
        return res.json({ token: cachedToken.token });
      }
      cachedToken = await getMapsToken();
      res.json({ token: cachedToken.token });
    } catch (error) {
      console.error('Error fetching maps token:', error);
      res.status(500).json({ error: 'Failed to fetch maps token' });
    }
  });

  // ── Auth: terminal -> browser cookie flow ───────────────────────

  router.post('/auth/code', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    try {
      jwt.verify(token, jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }

    const code = randomBytes(32).toString('hex');
    pendingCodes.set(code, { token, expires: Date.now() + CODE_TTL_MS });

    for (const [k, v] of pendingCodes) {
      if (v.expires < Date.now()) pendingCodes.delete(k);
    }

    res.json({ code });
  });

  router.get('/auth/callback', (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const entry = pendingCodes.get(code);
    if (!entry || entry.expires < Date.now()) {
      pendingCodes.delete(code);
      return res.status(401).send('Invalid or expired code');
    }

    pendingCodes.delete(code);

    res.cookie('auth_token', entry.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.redirect(frontendUrl || '/');
  });

  router.get('/auth/whoami', (req, res) => {
    const cookies = req.headers.cookie || '';
    const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
    if (!match) return res.status(401).json({ error: 'not authenticated' });

    try {
      const decoded = jwt.verify(match.slice('auth_token='.length), jwtSecret);
      res.json({ name: decoded.name || null, email: decoded.email || decoded.sub });
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  });

  router.get('/auth/logout', (_req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    res.redirect(frontendUrl || '/');
  });

  // ── Blob helpers ────────────────────────────────────────────────

  async function readBlob() {
    const blob = propertiesContainerClient.getBlobClient(BLOB_NAME);
    const props = await blob.getProperties().catch(() => null);
    if (!props) return { data: structuredClone(EMPTY_DATA), updatedAt: null };

    const download = await blob.download(0);
    const chunks = [];
    for await (const chunk of download.readableStreamBody) {
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    return { data: parsed, updatedAt: props.lastModified.toISOString() };
  }

  async function writeBlob(data, lastKnownVersion) {
    const blob = propertiesContainerClient.getBlockBlobClient(BLOB_NAME);

    if (lastKnownVersion) {
      const props = await blob.getProperties().catch(() => null);
      if (props) {
        const currentVersion = props.lastModified.getTime();
        const clientVersion = new Date(lastKnownVersion).getTime();
        if (currentVersion > clientVersion) {
          const current = await readBlob();
          return { conflict: true, current };
        }
      }
    }

    const content = JSON.stringify(data);
    await blob.upload(content, content.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });

    const props = await blob.getProperties();
    return { conflict: false, updatedAt: props.lastModified.toISOString() };
  }

  // ── Public: read all properties ─────────────────────────────────

  router.get('/api/properties', async (_req, res) => {
    try {
      const { data, updatedAt } = await readBlob();
      res.json({
        properties: data.properties || [],
        checklistSchema: data.checklistSchema || [],
        updatedAt,
      });
    } catch (error) {
      console.error('Error fetching properties:', error);
      res.status(500).json({ error: 'Failed to fetch properties' });
    }
  });

  // ── Admin: add property ─────────────────────────────────────────

  router.post('/api/properties', requireAuth, async (req, res) => {
    try {
      const { property, lastKnownVersion } = req.body;
      if (!property?.address) return res.status(400).json({ error: 'address required' });

      const { data } = await readBlob();
      if (!property.id) property.id = randomBytes(16).toString('hex');
      property.addedAt = property.addedAt || new Date().toISOString();
      property.updatedAt = new Date().toISOString();
      data.properties.push(property);

      const result = await writeBlob(data, lastKnownVersion);
      if (result.conflict) {
        return res.status(409).json({ error: 'Conflict', current: result.current.data });
      }
      res.json({ property, updatedAt: result.updatedAt });
    } catch (error) {
      console.error('Error adding property:', error);
      res.status(500).json({ error: 'Failed to add property' });
    }
  });

  // ── Admin: update property ──────────────────────────────────────

  router.put('/api/properties/:id', requireAuth, async (req, res) => {
    try {
      const { property, lastKnownVersion } = req.body;
      const { data } = await readBlob();
      const idx = data.properties.findIndex(p => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Property not found' });

      property.updatedAt = new Date().toISOString();
      data.properties[idx] = { ...data.properties[idx], ...property };

      const result = await writeBlob(data, lastKnownVersion);
      if (result.conflict) {
        return res.status(409).json({ error: 'Conflict', current: result.current.data });
      }
      res.json({ property: data.properties[idx], updatedAt: result.updatedAt });
    } catch (error) {
      console.error('Error updating property:', error);
      res.status(500).json({ error: 'Failed to update property' });
    }
  });

  // ── Admin: delete property ──────────────────────────────────────

  router.delete('/api/properties/:id', requireAuth, async (req, res) => {
    try {
      const { lastKnownVersion } = req.body || {};
      const { data } = await readBlob();
      const idx = data.properties.findIndex(p => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Property not found' });

      data.properties.splice(idx, 1);

      const result = await writeBlob(data, lastKnownVersion);
      if (result.conflict) {
        return res.status(409).json({ error: 'Conflict', current: result.current.data });
      }
      res.json({ updatedAt: result.updatedAt });
    } catch (error) {
      console.error('Error deleting property:', error);
      res.status(500).json({ error: 'Failed to delete property' });
    }
  });

  // ── Admin: update checklist schema ──────────────────────────────

  router.put('/api/checklist-schema', requireAuth, async (req, res) => {
    try {
      const { checklistSchema, lastKnownVersion } = req.body;
      if (!Array.isArray(checklistSchema)) {
        return res.status(400).json({ error: 'checklistSchema must be an array' });
      }

      const { data } = await readBlob();
      data.checklistSchema = checklistSchema;

      const result = await writeBlob(data, lastKnownVersion);
      if (result.conflict) {
        return res.status(409).json({ error: 'Conflict', current: result.current.data });
      }
      res.json({ checklistSchema, updatedAt: result.updatedAt });
    } catch (error) {
      console.error('Error updating checklist schema:', error);
      res.status(500).json({ error: 'Failed to update checklist schema' });
    }
  });

  return router;
}
