// Microsoft sign-in happens upstream at auth.romaine.life. This page:
//   1. On boot, checks for a stored house-hunt session JWT and validates it
//      via /api/auth/me.
//   2. If no valid session, tries to fetch an auth.romaine.life JWT from
//      that service's /api/auth/token endpoint — the auth-service session
//      cookie is on `.romaine.life` so it's auto-attached. If the user is
//      already signed into auth.romaine.life from another app, this is the
//      seamless path that lands them signed in here without any redirect.
//      The JWT is then exchanged at /api/auth/exchange for a house-hunt-
//      signed session JWT.
//   3. If both fail, render the Sign-in button.

const TOKEN_KEY = 'auth-token';

let authToken = null;
let currentUser = null;
let cachedConfig = null;

export function getToken() { return authToken; }
export function getUser() { return currentUser; }
export function isAuthenticated() { return !!authToken; }

async function fetchConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  cachedConfig = await res.json();
  return cachedConfig;
}

async function fetchUpstreamJWT(authURL) {
  try {
    const res = await fetch(`${authURL}/api/auth/token`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token ?? null;
  } catch {
    return null;
  }
}

async function exchange(upstreamJWT) {
  const res = await fetch('/api/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_jwt: upstreamJWT }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sign-in exchange failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

/**
 * Boot-time auth check. Resolves to true if signed in. Does NOT trigger a
 * redirect on its own — the page shows a Sign-in button for that.
 */
export async function initAuth() {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${stored}` },
      });
      if (res.ok) {
        authToken = stored;
        currentUser = await res.json();
        return true;
      }
    } catch {
      // fall through to silent exchange
    }
    localStorage.removeItem(TOKEN_KEY);
  }

  let config;
  try {
    config = await fetchConfig();
  } catch (e) {
    console.info('auth config unavailable; rendering unauthenticated', e);
    return false;
  }
  const upstreamJWT = await fetchUpstreamJWT(config.auth_url);
  if (!upstreamJWT) return false;

  try {
    const body = await exchange(upstreamJWT);
    authToken = body.token;
    currentUser = body.user;
    localStorage.setItem(TOKEN_KEY, authToken);
    return true;
  } catch (e) {
    console.warn('silent exchange failed; user must click Sign-in', e);
    return false;
  }
}

/** User-initiated sign-in: redirect to auth.romaine.life's Microsoft flow. */
export async function login() {
  const config = await fetchConfig();
  const callbackURL = encodeURIComponent(window.location.origin + window.location.pathname);
  // auth.romaine.life exposes a GET endpoint at /sign-in/microsoft that takes
  // callbackURL as a query param, kicks off Better Auth's social flow, and
  // 302s back to the callback once Microsoft completes. The Better Auth
  // routes under /api/auth/* are POST-only, so a top-level GET there 404s.
  window.location.href = `${config.auth_url}/sign-in/microsoft?callbackURL=${callbackURL}`;
}

export async function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // best-effort
  }
  // Also clear the auth.romaine.life session cookie so the next page load
  // doesn't silently re-SSO via fetchUpstreamJWT.
  try {
    const config = await fetchConfig();
    await fetch(`${config.auth_url}/api/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // best-effort
  }
  window.location.reload();
}
