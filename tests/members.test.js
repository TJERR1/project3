import { describe, it, expect, beforeEach } from 'vitest';
import { api, resetDb, signup } from './helpers.js';

let ann, bob, cat, boardId, bobId;
beforeEach(async () => {
  await resetDb();
  ann = await signup('ann@example.com');
  bob = await signup('bob@example.com');
  cat = await signup('cat@example.com');
  boardId = (await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann })).body.board.id;
  bobId = (await api('GET', '/api/auth/me', { cookie: bob })).body.user.id;
});

const members = (path = '') => `/api/boards/${boardId}/members${path}`;

describe('members', () => {
  it('owner adds a member by email, case-insensitively', async () => {
    const r = await api('POST', members(), { body: { email: ' BOB@example.com ', role: 'viewer' }, cookie: ann });
    expect(r.status).toBe(201);
    expect(r.body.member).toEqual({ user_id: bobId, email: 'bob@example.com', role: 'viewer' });
    const list = await api('GET', members(), { cookie: bob });
    expect(list.status).toBe(200);
    expect(list.body.members.map((m) => m.email).sort()).toEqual(['ann@example.com', 'bob@example.com']);
  });

  it('rejects unknown email, bad role, and owner role', async () => {
    expect((await api('POST', members(), { body: { email: 'zed@example.com', role: 'viewer' }, cookie: ann })).status).toBe(404);
    expect((await api('POST', members(), { body: { email: 'bob@example.com', role: 'boss' }, cookie: ann })).status).toBe(400);
    expect((await api('POST', members(), { body: { email: 'bob@example.com', role: 'owner' }, cookie: ann })).status).toBe(400);
  });

  it('returns 409 when the user is already a member, including the owner', async () => {
    await api('POST', members(), { body: { email: 'bob@example.com', role: 'viewer' }, cookie: ann });
    expect((await api('POST', members(), { body: { email: 'bob@example.com', role: 'editor' }, cookie: ann })).status).toBe(409);
    expect((await api('POST', members(), { body: { email: 'ann@example.com', role: 'editor' }, cookie: ann })).status).toBe(409);
  });

  it('only the owner manages members', async () => {
    await api('POST', members(), { body: { email: 'bob@example.com', role: 'editor' }, cookie: ann });
    expect((await api('POST', members(), { body: { email: 'cat@example.com', role: 'viewer' }, cookie: bob })).status).toBe(403);
    expect((await api('PATCH', members(`/${bobId}`), { body: { role: 'viewer' }, cookie: bob })).status).toBe(403);
    expect((await api('DELETE', members(`/${bobId}`), { cookie: bob })).status).toBe(403);
    expect((await api('GET', members(), { cookie: cat })).status).toBe(404);
  });

  it('owner changes a role and removes a member', async () => {
    await api('POST', members(), { body: { email: 'bob@example.com', role: 'viewer' }, cookie: ann });
    const r = await api('PATCH', members(`/${bobId}`), { body: { role: 'editor' }, cookie: ann });
    expect(r.status).toBe(200);
    expect(r.body.member.role).toBe('editor');
    expect((await api('DELETE', members(`/${bobId}`), { cookie: ann })).status).toBe(204);
    expect((await api('GET', `/api/boards/${boardId}`, { cookie: bob })).status).toBe(404);
  });

  it('returns 404 for unknown or non-uuid member ids', async () => {
    expect((await api('PATCH', members('/nope'), { body: { role: 'editor' }, cookie: ann })).status).toBe(404);
    expect((await api('DELETE', members(`/${bobId}`), { cookie: ann })).status).toBe(404);
  });

  it('owner cannot be demoted or removed', async () => {
    const annId = (await api('GET', '/api/auth/me', { cookie: ann })).body.user.id;
    expect((await api('PATCH', members(`/${annId}`), { body: { role: 'viewer' }, cookie: ann })).status).toBe(403);
    expect((await api('DELETE', members(`/${annId}`), { cookie: ann })).status).toBe(403);
    expect((await api('DELETE', members('/me'), { cookie: ann })).status).toBe(403);
  });

  it('a non-owner member can leave', async () => {
    await api('POST', members(), { body: { email: 'bob@example.com', role: 'editor' }, cookie: ann });
    expect((await api('DELETE', members('/me'), { cookie: bob })).status).toBe(204);
    expect((await api('GET', `/api/boards/${boardId}`, { cookie: bob })).status).toBe(404);
  });
});
