import fs from 'node:fs';
import { app } from '../src/app.js';
import { createDb } from '../src/db.js';

function loadDevVars() {
  const out = {};
  try {
    const text = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // no .dev.vars; rely on process.env
  }
  return out;
}

const vars = loadDevVars();
export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL ?? vars.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? vars.SUPABASE_SERVICE_KEY,
};

// Deleting every user cascades to sessions, boards, board_members and cards.
export async function resetDb() {
  const db = createDb(env);
  const { error } = await db.from('users').delete().not('id', 'is', null);
  if (error) throw error;
}

// api('POST', '/api/auth/login', { body: {...}, cookie: 'sid=...' })
// api('POST', '/api/x', { rawBody: '{not json' }) sends the string as-is.
// api('POST', '/api/x', { origin: 'https://host' }) makes the request as if it arrived over that origin.
export async function api(method, path, { body, rawBody, cookie, origin } = {}) {
  const headers = {};
  let payload;
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  const res = await app.request(origin ? origin + path : path, { method, headers, body: payload }, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
}

// Registers then logs in; returns the session cookie string.
export async function signup(email, password = 'password123') {
  await api('POST', '/api/auth/register', { body: { email, password } });
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (!r.cookie) throw new Error(`signup failed for ${email}: ${r.status}`);
  return r.cookie;
}
