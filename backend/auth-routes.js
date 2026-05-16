import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { exchangeRomaineLifeToken } from './auth.js';

const AUTH_URL = 'https://auth.romaine.life';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Routes for the auth.romaine.life delegation flow. Microsoft sign-in itself
// happens upstream at auth.romaine.life; the SPA pulls a JWT from that
// service's /api/auth/token (the .romaine.life session cookie is auto-
// attached on cross-origin fetches because the auth service mounts CORS
// with credentials for this origin) and POSTs it here to be exchanged for
// a house-hunt-signed session JWT. The role claim from auth.romaine.life is
// the single access gate — no per-app email allowlist.
export function createAuthRoutes({ jwtSecret, requireAuth }) {
  const router = Router();

  function issueToken(user) {
    return jwt.sign(
      { sub: user.sub, email: user.email, name: user.name, role: user.role },
      jwtSecret,
      { expiresIn: SESSION_TTL_SECONDS },
    );
  }

  router.get('/api/config', (_req, res) => {
    res.json({ auth_url: AUTH_URL });
  });

  router.post('/api/auth/exchange', async (req, res) => {
    const { auth_jwt: authJWT } = req.body ?? {};
    if (!authJWT || typeof authJWT !== 'string') {
      return res.status(400).json({ error: 'missing auth_jwt' });
    }
    try {
      const user = await exchangeRomaineLifeToken(authJWT);
      const token = issueToken(user);
      res.json({ token, user });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err.message || 'exchange failed' });
    }
  });

  router.get('/api/auth/me', requireAuth, (req, res) => {
    res.json(req.user);
  });

  router.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('auth_token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    res.json({ status: 'ok' });
  });

  return router;
}
