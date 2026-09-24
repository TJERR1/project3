import { describe, it, expect, beforeEach } from 'vitest';
import { api, resetDb } from './helpers.js';

beforeEach(resetDb);

const creds = { email: 'ann@example.com', password: 'password123' };

describe('register', () => {
  it('creates a user and returns 201 without the hash', async () => {
    const r = await api('POST', '/api/auth/register', { body: creds });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe('ann@example.com');
    expect(r.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(r.body)).not.toContain('pbkdf2');
  });

  it('normalises email case and whitespace', async () => {
    const r = await api('POST', '/api/auth/register', { body: { ...creds, email: '  Ann@Example.com ' } });
    expect(r.body.user.email).toBe('ann@example.com');
  });

  it('rejects duplicate email with 409', async () => {
    await api('POST', '/api/auth/register', { body: creds });
    const r = await api('POST', '/api/auth/register', { body: { ...creds, email: 'ANN@example.com' } });
    expect(r.status).toBe(409);
  });

  it('validates input', async () => {
    expect((await api('POST', '/api/auth/register', { body: { email: 'nope', password: 'password123' } })).status).toBe(400);
    expect((await api('POST', '/api/auth/register', { body: { email: 'a@b.c', password: 'short' } })).status).toBe(400);
    expect((await api('POST', '/api/auth/register', { body: {} })).status).toBe(400);
  });

  it('returns 400 on malformed json', async () => {
    const r = await api('POST', '/api/auth/register', { rawBody: '{not json' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });
});

describe('login and session', () => {
  beforeEach(async () => { await api('POST', '/api/auth/register', { body: creds }); });

  it('sets an httpOnly sid cookie on success', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: 'ANN@example.com', password: 'password123' } });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('ann@example.com');
    expect(r.setCookie).toMatch(/^sid=[0-9a-f]{64};/);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/SameSite=Lax/i);
    expect(r.setCookie).toMatch(/Path=\//);
  });

  it('rejects wrong password and unknown email with 401', async () => {
    expect((await api('POST', '/api/auth/login', { body: { ...creds, password: 'password124' } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'bob@example.com', password: 'password123' } })).status).toBe(401);
  });

  it('me returns the user with a cookie and 401 without', async () => {
    const login = await api('POST', '/api/auth/login', { body: creds });
    const me = await api('GET', '/api/auth/me', { cookie: login.cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ann@example.com');
    expect((await api('GET', '/api/auth/me')).status).toBe(401);
    expect((await api('GET', '/api/auth/me', { cookie: 'sid=deadbeef' })).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const login = await api('POST', '/api/auth/login', { body: creds });
    const out = await api('POST', '/api/auth/logout', { cookie: login.cookie });
    expect(out.status).toBe(204);
    expect((await api('GET', '/api/auth/me', { cookie: login.cookie })).status).toBe(401);
  });
});
