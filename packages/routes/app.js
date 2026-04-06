import { Router } from 'express';
import { randomBytes } from 'node:crypto';

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
 * Auth is handled by the shared msAuth middleware mounted in the API.
 * This package only provides data endpoints + maps token.
 *
 * @param {{
 *   requireAuth: Function,
 *   propertiesContainerClient: import('@azure/storage-blob').ContainerClient,
 *   getMapsToken: () => Promise<{token: string, expiresOnTimestamp: number}>,
 * }} opts
 */
export function createHouseHuntRoutes({ requireAuth, propertiesContainerClient, getMapsToken }) {
  const router = Router();

  // Health check
  router.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── Azure Maps token (public — map must render for everyone) ────

  let cachedToken = null;

  router.get('/maps/token', async (_req, res) => {
    try {
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
