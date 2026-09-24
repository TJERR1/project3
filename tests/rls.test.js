import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { env, resetDb, signup } from './helpers.js';

// The anon key is public, so PostgREST must not expose any app table to it.
describe('database is closed to the anon key', () => {
  const TABLES = ['users', 'sessions', 'boards', 'board_members', 'cards'];
  let anon;

  beforeAll(async () => {
    if (!env.SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY is not set (see .dev.vars.example)');
    anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await resetDb();
    await signup('rls@example.com');
  });

  for (const table of TABLES) {
    it(`cannot read ${table}`, async () => {
      const { data, error } = await anon.from(table).select('*');
      expect(data ?? []).toEqual([]);
      expect(error).not.toBeNull();
    });
  }

  it('cannot insert users', async () => {
    const { error } = await anon.from('users').insert({ email: 'evil@example.com', password_hash: 'x' });
    expect(error).not.toBeNull();
  });
});
