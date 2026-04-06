import { CONFIG } from './config.js';

export function logout() {
  window.location.href = `${CONFIG.apiUrl}/auth/logout`;
}

export async function fetchWhoami() {
  try {
    const res = await fetch(`${CONFIG.apiUrl}/auth/whoami`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
