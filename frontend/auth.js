import { CONFIG } from './config.js';

let msalInstance = null;
let authToken = null;
let currentUser = null;

export function getToken() { return authToken; }
export function getUser() { return currentUser; }
export function isAuthenticated() { return !!authToken; }

export async function initAuth() {
  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.microsoftClientId,
      authority: 'https://login.microsoftonline.com/consumers',
      redirectUri: window.location.origin,
    },
  });
  await msalInstance.initialize();

  // Handle redirect response
  const response = await msalInstance.handleRedirectPromise();
  if (response) {
    return handleMsalResponse(response);
  }

  // Try silent token acquisition for existing sessions
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    try {
      const silentResponse = await msalInstance.acquireTokenSilent({
        scopes: ['openid', 'profile', 'email'],
        account: accounts[0],
      });
      return handleMsalResponse(silentResponse);
    } catch {
      return false;
    }
  }

  return false;
}

async function handleMsalResponse(response) {
  const res = await fetch(`${CONFIG.apiUrl}/auth/microsoft/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: response.idToken }),
  });

  if (!res.ok) return false;

  const data = await res.json();
  authToken = data.token;
  currentUser = data.user;
  return true;
}

export function login() {
  msalInstance.loginRedirect({
    scopes: ['openid', 'profile', 'email'],
    prompt: 'select_account',
  });
}

export function logout() {
  authToken = null;
  currentUser = null;
  msalInstance.logoutRedirect();
}
