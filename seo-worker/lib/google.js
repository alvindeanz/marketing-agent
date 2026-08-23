'use strict';
// Google service account auth: RS256 JWT -> OAuth2 access token.
// Zero npm dependencies, uses node:crypto createSign.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { requestJson } = require('./http');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const cache = new Map(); // cacheKey -> { token, expiresAt }

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function readKeyFile(keyFile) {
  let raw;
  try {
    raw = fs.readFileSync(keyFile, 'utf8');
  } catch (e) {
    throw new Error('cannot read GA4 service account key file ' + keyFile + ' :: ' + e.message);
  }
  let key;
  try {
    key = JSON.parse(raw);
  } catch (e) {
    throw new Error('service account key file is not valid JSON: ' + keyFile);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('service account key file missing client_email or private_key: ' + keyFile);
  }
  return key;
}

/**
 * Get an OAuth2 access token for the given scopes.
 * scopes: array of scope URLs. Tokens are cached in memory until 60s before expiry.
 */
async function getAccessToken(keyFile, scopes) {
  const scopeStr = scopes.slice().sort().join(' ');
  const cacheKey = keyFile + '|' + scopeStr;
  const hit = cache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.expiresAt > now + 60) return hit.token;

  const key = readKeyFile(keyFile);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope: scopeStr,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const signingInput = b64url(header) + '.' + b64url(claims);
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(key.private_key)
    .toString('base64url');
  const assertion = signingInput + '.' + signature;

  const form =
    'grant_type=' +
    encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
    '&assertion=' +
    encodeURIComponent(assertion);

  const res = await requestJson(TOKEN_URL, {
    method: 'POST',
    body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeoutMs: 30000,
  });
  if (!res || !res.access_token) {
    throw new Error('token endpoint returned no access_token');
  }
  cache.set(cacheKey, {
    token: res.access_token,
    expiresAt: now + (Number(res.expires_in) || 3600),
  });
  return res.access_token;
}

/** POST a JSON body to a Google API endpoint with a service account token. */
async function googlePost(keyFile, scopes, url, body, timeoutMs) {
  const token = await getAccessToken(keyFile, scopes);
  return requestJson(url, {
    method: 'POST',
    body,
    timeoutMs: timeoutMs || 60000,
    headers: { Authorization: 'Bearer ' + token },
  });
}

module.exports = { getAccessToken, googlePost };
