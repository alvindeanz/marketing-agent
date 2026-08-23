'use strict';
// Minimal HTTP/HTTPS client. Zero npm dependencies, node built-ins only.

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const { URL } = require('node:url');

/**
 * Perform an HTTP request.
 * opts: { method, headers, body (string|object), timeoutMs }
 * Resolves { status, headers, text, json }. Never throws on non 2xx.
 */
function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('bad url: ' + urlStr));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const timeoutMs = opts.timeoutMs || 60000;

    let body = null;
    if (opts.body !== undefined && opts.body !== null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    const headers = Object.assign({}, opts.headers || {});
    const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (body !== null && !hasCt) headers['Content-Type'] = 'application/json';
    if (body !== null) headers['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch (e) {
              json = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('http timeout after ' + timeoutMs + 'ms: ' + urlStr));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Same as request() but throws on non 2xx and returns the parsed JSON body. */
async function requestJson(urlStr, opts = {}) {
  const r = await request(urlStr, opts);
  if (r.status < 200 || r.status >= 300) {
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, 600);
    const err = new Error(
      'HTTP ' + r.status + ' ' + (opts.method || 'GET') + ' ' + urlStr + ' :: ' + snippet
    );
    err.status = r.status;
    err.responseText = r.text;
    throw err;
  }
  return r.json;
}

/**
 * Download a URL straight to disk. Separate from request() because that one
 * decodes the body as utf8, which would quietly corrupt a png.
 * Resolves { status, bytes }. Throws on non 2xx and removes the part file.
 */
function downloadTo(urlStr, destPath, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('bad url: ' + urlStr));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const timeoutMs = opts.timeoutMs || 60000;
    const maxBytes = opts.maxBytes || 0;

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: Object.assign({}, opts.headers || {}),
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
            const err = new Error('HTTP ' + res.statusCode + ' GET ' + urlStr + ' :: ' + snippet);
            err.status = res.statusCode;
            reject(err);
          });
          return;
        }
        let bytes = 0;
        let aborted = false;
        const out = fs.createWriteStream(destPath);
        const fail = (err) => {
          if (aborted) return;
          aborted = true;
          res.destroy();
          out.destroy();
          try {
            fs.unlinkSync(destPath);
          } catch (e) {
            /* nothing written yet */
          }
          reject(err);
        };
        res.on('data', (c) => {
          bytes += c.length;
          if (maxBytes && bytes > maxBytes) {
            fail(new Error('download over ' + maxBytes + ' bytes: ' + urlStr));
          }
        });
        res.on('error', fail);
        out.on('error', fail);
        out.on('close', () => {
          if (aborted) return;
          resolve({ status: res.statusCode, bytes });
        });
        res.pipe(out);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('http timeout after ' + timeoutMs + 'ms: ' + urlStr));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { request, requestJson, downloadTo };
