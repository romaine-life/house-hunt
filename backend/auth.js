import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

// Single upstream identity provider. auth.romaine.life's Better Auth JWT
// plugin publishes RS256 keys at /api/auth/jwks; the issuer claim is the
// service's baseURL. jose's createRemoteJWKSet caches per-kid with a 5min
// stale-while-revalidate window — good enough that we don't roll our own.
const AUTH_ROMAINE_LIFE_JWKS = createRemoteJWKSet(
  new URL('https://auth.romaine.life/api/auth/jwks'),
);
const AUTH_ROMAINE_LIFE_ISSUER = 'https://auth.romaine.life';
const ALLOWED_ROLES = new Set(['admin', 'user']);

/**
 * Verify a JWT issued by auth.romaine.life and return the user identity
 * plus role. Throws an Error with `status` (401|403) set so the caller can
 * surface the right HTTP code. Gating is solely on the role claim:
 * `pending` (auth.romaine.life's default for fresh Microsoft sign-ups)
 * gets a 403; an admin must promote the user via auth.romaine.life/admin
 * before they're useful here. No per-app email allowlist.
 */
export async function exchangeRomaineLifeToken(authJWT) {
  let payload;
  try {
    ({ payload } = await jwtVerify(authJWT, AUTH_ROMAINE_LIFE_JWKS, {
      issuer: AUTH_ROMAINE_LIFE_ISSUER,
      algorithms: ['RS256'],
      clockTolerance: '60s',
    }));
  } catch (err) {
    const reason = err instanceof joseErrors.JOSEError ? err.message : 'invalid token';
    const e = new Error(`invalid auth.romaine.life token: ${reason}`);
    e.status = 401;
    throw e;
  }

  const role = typeof payload.role === 'string' ? payload.role : '';
  if (!ALLOWED_ROLES.has(role)) {
    const e = new Error(`role not approved by auth.romaine.life: ${role || '(missing)'}`);
    e.status = 403;
    throw e;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) {
    const e = new Error('token missing email claim');
    e.status = 401;
    throw e;
  }

  return {
    sub: typeof payload.sub === 'string' ? payload.sub : '',
    email,
    name: typeof payload.name === 'string' ? payload.name : '',
    role,
  };
}

/**
 * Creates Express middleware that verifies house-hunt's own HS256 session
 * JWTs (minted by /api/auth/exchange). Populates `req.user` with
 * `{ sub, email, name, role }`.
 */
export function createRequireAuth({ jwtSecret }) {
  return (req, res, next) => {
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      const cookies = req.headers.cookie || '';
      const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
      if (match) token = match.slice('auth_token='.length);
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing authentication' });
    }

    try {
      const payload = jwt.verify(token, jwtSecret);
      req.user = {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      };
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

/**
 * Middleware that requires the authenticated user to have the 'admin' role.
 * Must be used after requireAuth.
 */
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
