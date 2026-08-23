'use strict';
// Minimal HTTP/HTTPS client. Zero npm dependencies, node built-ins only.

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
      // A Buffer goes out untouched: JSON.stringify would turn a multipart body
      // into {"type":"Buffer","data":[...]} and the server would see nothing.
      if (Buffer.isBuffer(opts.body)) body = opts.body;
      else body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
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
 * Build a multipart/form-data body.
 * fields: { name: value } plain text parts, file: { field, filename, contentType, buffer }
 * Returns { contentType, body } with body as a Buffer.
 * Quotes and line breaks are stripped out of every name that lands in a part
 * header: a filename carrying a CRLF would let the caller forge headers.
 */
function multipartBody(fields, file) {
  const boundary = '----seoworker' + crypto.randomBytes(16).toString('hex');
  const clean = (s) => String(s == null ? '' : s).replace(/[\r\n"]/g, '_');
  const parts = [];
  Object.keys(fields || {}).forEach((k) => {
    parts.push(
      Buffer.from(
        '--' + boundary + '\r\n' +
          'Content-Disposition: form-data; name="' + clean(k) + '"\r\n\r\n' +
          String(fields[k]) + '\r\n',
        'utf8'
      )
    );
  });
  parts.push(
    Buffer.from(
      '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + clean(file.field || 'file') +
        '"; filename="' + clean(file.filename || 'file') + '"\r\n' +
        'Content-Type: ' + clean(file.contentType || 'application/octet-stream') + '\r\n\r\n',
      'utf8'
    )
  );
  parts.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(String(file.buffer), 'utf8'));
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return {
    contentType: 'multipart/form-data; boundary=' + boundary,
    body: Buffer.concat(parts),
  };
}

/**
 * POST one file as multipart/form-data. Same contract as requestJson: throws on
 * non 2xx, returns the parsed JSON body.
 * opts: { headers, timeoutMs, fields, file } with file as in multipartBody.
 */
async function postMultipart(urlStr, opts = {}) {
  const mp = multipartBody(opts.fields || {}, opts.file || {});
  const headers = Object.assign({}, opts.headers || {}, { 'Content-Type': mp.contentType });
  const r = await request(urlStr, {
    method: 'POST',
    headers,
    body: mp.body,
    timeoutMs: opts.timeoutMs || 60000,
  });
  if (r.status < 200 || r.status >= 300) {
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, 600);
    const err = new Error('HTTP ' + r.status + ' POST ' + urlStr + ' :: ' + snippet);
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

module.exports = { request, requestJson, downloadTo, multipartBody, postMultipart };
