import { describe, it, expect } from 'vitest';
import { api, resetDb } from './helpers.js';

describe('smoke', () => {
  it('health endpoint responds', async () => {
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('unknown api route is a json 404', async () => {
    const r = await api('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Not found' });
  });

  it('can reach the local database', async () => {
    await expect(resetDb()).resolves.toBeUndefined();
  });
});
