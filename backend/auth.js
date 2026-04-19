import jwt from 'jsonwebtoken';

/**
 * Creates Express middleware that verifies self-signed JWTs.
 * Populates `req.user` with `{ sub, email, name, role }`.
 */
export function createRequireAuth({ jwtSecret }) {
  return (req, res, next) => {
    // Try Authorization header first, then cookie
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
        role: payload.role || 'member',
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
