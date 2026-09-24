import { createClient } from '@supabase/supabase-js';

export function createDb(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Await a supabase-js query builder and throw on error so the Hono onError
// handler turns it into a 500. Returns data only.
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// Parse a JSON body; returns null when the body is missing or malformed.
export async function readJson(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}
