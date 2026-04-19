import { Router } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const ALLOWED_EMAIL = 'nelson-devops-project@outlook.com';

const client = jwksClient({
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  cache: true,
  rateLimit: true,
});

function getSigningKey(header) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

function verifyMicrosoftToken(idToken, audience) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      (header, callback) => {
        getSigningKey(header).then((key) => callback(null, key)).catch(callback);
      },
      { audience, issuer: /^https:\/\/login\.microsoftonline\.com\/.*\/v2\.0$/ },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      },
    );
  });
}

/**
 * Shared Microsoft OAuth auth routes.
 *
 * POST /auth/microsoft/login – verify Microsoft ID token, issue app JWT
 *
 * `microsoftClientIds` is the full list of accepted audiences. Each app that
 * owns its own Azure AD app registration contributes its client ID here, and
 * jsonwebtoken accepts the token if its `aud` matches any entry.
 */
export function createMicrosoftRoutes({ jwtSecret, microsoftClientIds, accountContainer }) {
  const router = Router();

  function issueToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      jwtSecret,
      { expiresIn: '7d' },
    );
  }

  router.post('/auth/microsoft/login', async (req, res) => {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'credential required' });
    }

    try {
      const payload = await verifyMicrosoftToken(credential, microsoftClientIds);
      const email = payload.email || payload.preferred_username;

      const id = `microsoft|${payload.sub}`;
      const role = email?.toLowerCase() === ALLOWED_EMAIL ? 'admin' : 'viewer';
      const account = {
        id,
        userId: id,
        type: 'account',
        provider: 'microsoft',
        name: payload.name,
        email,
        role,
        updatedAt: new Date().toISOString(),
      };

      await accountContainer.items.upsert(account);

      const token = issueToken(account);
      res.json({ token, user: { id, name: account.name, email: account.email, role: account.role } });
    } catch (error) {
      console.error('Microsoft auth error:', error);
      res.status(401).json({ error: 'Invalid Microsoft credential' });
    }
  });

  return router;
}
