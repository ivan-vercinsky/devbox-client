const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { PublicClientApplication, CryptoProvider } = require('@azure/msal-node');
const settings = require('./settings');
const { captureRedirect, clearSession } = require('./authwindow');
const log = require('./log');

const SCOPES = {
  arm: ['https://management.azure.com/.default'],
  devcenter: ['https://devcenter.azure.com/.default'],
  avd: ['https://www.wvd.microsoft.com/.default'],
};

// Which borrowed client to use for each resource.
const CLIENT_FOR = { arm: 'azure', devcenter: 'azure', avd: 'rd' };

const crypto = new CryptoProvider();
const apps = new Map(); // key -> { pca, clientId, redirectUri }

function cachePlugin(name) {
  const file = path.join(app.getPath('userData'), `msal-${name}.bin`);
  const canEncrypt = () => safeStorage.isEncryptionAvailable();
  return {
    async beforeCacheAccess(ctx) {
      try {
        const raw = fs.readFileSync(file);
        ctx.tokenCache.deserialize(canEncrypt() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
      } catch {
        /* no cache yet */
      }
    },
    async afterCacheAccess(ctx) {
      if (!ctx.cacheHasChanged) return;
      const data = ctx.tokenCache.serialize();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, canEncrypt() ? safeStorage.encryptString(data) : data, { mode: 0o600 });
    },
  };
}

function getApp(key) {
  const s = settings.load();
  const clientId = key === 'azure' ? s.azureClientId : s.rdClientId;
  const redirectUri = key === 'azure' ? s.azureRedirectUri : s.rdRedirectUri;
  const cached = apps.get(key);
  if (cached && cached.clientId === clientId && cached.tenant === s.tenant) return cached;
  const pca = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${s.tenant}` },
    cache: { cachePlugin: cachePlugin(key) },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        logLevel: 1, // warning
        loggerCallback: (_lvl, msg) => log.debug('msal:', msg),
      },
    },
  });
  const entry = { pca, clientId, redirectUri, tenant: s.tenant };
  apps.set(key, entry);
  return entry;
}

let preferredUsername = null;

async function pickAccount(pca) {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (!accounts.length) return null;
  return accounts.find((a) => a.username === preferredUsername) || accounts[0];
}

async function interactive(key, scopes, { loginHint, parent } = {}) {
  const { pca, redirectUri, clientId } = getApp(key);
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const url = await pca.getAuthCodeUrl({
    scopes,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    loginHint: loginHint || undefined,
    prompt: loginHint ? undefined : 'select_account',
  });
  log.info(`auth: interactive sign-in (client ${clientId}) for ${scopes.join(' ')}`);
  const redirect = await captureRedirect(url, redirectUri, { parent, title: 'Sign in to Microsoft' });
  const code = new URL(redirect).searchParams.get('code');
  if (!code) throw new Error('No authorization code in redirect');
  const result = await pca.acquireTokenByCode({ code, scopes, redirectUri, codeVerifier: verifier });
  preferredUsername = result.account?.username || preferredUsername;
  return result;
}

/** Get an access token for `resource` ('arm' | 'devcenter' | 'avd'). */
async function getToken(resource, { allowInteractive = true, parent } = {}) {
  const key = CLIENT_FOR[resource];
  const scopes = SCOPES[resource];
  const { pca } = getApp(key);
  const account = await pickAccount(pca);
  if (account) {
    try {
      const r = await pca.acquireTokenSilent({
        account,
        scopes,
        authority: `https://login.microsoftonline.com/${account.tenantId}`,
      });
      return r.accessToken;
    } catch (e) {
      log.debug(`auth: silent ${resource} failed: ${e.errorCode || e.message}`);
    }
  }
  if (!allowInteractive) throw new Error('Not signed in');
  const r = await interactive(key, scopes, { loginHint: account?.username || preferredUsername, parent });
  return r.accessToken;
}

async function signIn(parent) {
  const r = await interactive('azure', SCOPES.devcenter, { parent });
  return { username: r.account.username, name: r.account.name, tenantId: r.account.tenantId };
}

async function currentAccount() {
  const account = await pickAccount(getApp('azure').pca);
  if (!account) return null;
  preferredUsername = account.username;
  return { username: account.username, name: account.name, tenantId: account.tenantId };
}

async function signOut() {
  for (const key of ['azure', 'rd']) {
    const { pca } = getApp(key);
    for (const a of await pca.getTokenCache().getAllAccounts()) await pca.getTokenCache().removeAccount(a);
  }
  preferredUsername = null;
  await clearSession();
}

module.exports = { getToken, signIn, signOut, currentAccount };
