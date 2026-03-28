import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

// Cache keyed by service account client_email to avoid re-authorizing the
// same credentials on every reply. One entry per tenant.
const clientCache = new Map();

/**
 * Return (and cache) Google Sheets + Drive clients for the given credentials.
 * @param {object} credentials  Tenant.credentials.googleServiceAccountJson
 */
export async function getGoogleClients(credentials) {
  const cacheKey = credentials?.client_email ?? JSON.stringify(credentials);

  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const client = await auth.getClient();
  const clients = {
    sheets: google.sheets({ version: 'v4', auth: client }),
    drive:  google.drive({ version: 'v3', auth: client }),
    auth,
  };

  clientCache.set(cacheKey, clients);
  return clients;
}
