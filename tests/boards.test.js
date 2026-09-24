import { describe, it, expect, beforeEach } from 'vitest';
import { api, resetDb, signup } from './helpers.js';

let ann, bob;
beforeEach(async () => {
  await resetDb();
  ann = await signup('ann@example.com');
  bob = await signup('bob@example.com');
});

describe('boards', () => {
  it('requires login', async () => {
    expect((await api('GET', '/api/boards')).status).toBe(401);
    expect((await api('POST', '/api/boards', { body: { name: 'x' } })).status).toBe(401);
  });

  it('creates a board with the creator as owner', async () => {
    const r = await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann });
    expect(r.status).toBe(201);
    expect(r.body.board.name).toBe('Launch');
    const list = await api('GET', '/api/boards', { cookie: ann });
    expect(list.body.boards).toHaveLength(1);
    expect(list.body.boards[0]).toMatchObject({ id: r.body.board.id, name: 'Launch', role: 'owner' });
  });

  it('validates the name', async () => {
    expect((await api('POST', '/api/boards', { body: { name: '' }, cookie: ann })).status).toBe(400);
    expect((await api('POST', '/api/boards', { body: { name: 'x'.repeat(201) }, cookie: ann })).status).toBe(400);
    expect((await api('POST', '/api/boards', { rawBody: 'nope', cookie: ann })).status).toBe(400);
  });

  it('lists only boards the caller belongs to', async () => {
    await api('POST', '/api/boards', { body: { name: 'Ann board' }, cookie: ann });
    await api('POST', '/api/boards', { body: { name: 'Bob board' }, cookie: bob });
    const list = await api('GET', '/api/boards', { cookie: bob });
    expect(list.body.boards.map((b) => b.name)).toEqual(['Bob board']);
  });

  it('returns board detail with role, members and cards', async () => {
    const { body } = await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann });
    const r = await api('GET', `/api/boards/${body.board.id}`, { cookie: ann });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('owner');
    expect(r.body.board.name).toBe('Launch');
    expect(r.body.members).toEqual([{ user_id: expect.any(String), email: 'ann@example.com', role: 'owner' }]);
    expect(r.body.cards).toEqual([]);
  });

  it('hides boards from non-members with 404', async () => {
    const { body } = await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann });
    expect((await api('GET', `/api/boards/${body.board.id}`, { cookie: bob })).status).toBe(404);
    expect((await api('PATCH', `/api/boards/${body.board.id}`, { body: { name: 'x' }, cookie: bob })).status).toBe(404);
    expect((await api('DELETE', `/api/boards/${body.board.id}`, { cookie: bob })).status).toBe(404);
  });

  it('returns 404 for a non-uuid board id', async () => {
    expect((await api('GET', '/api/boards/not-a-uuid', { cookie: ann })).status).toBe(404);
  });

  it('owner can rename and delete', async () => {
    const { body } = await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann });
    const renamed = await api('PATCH', `/api/boards/${body.board.id}`, { body: { name: 'Liftoff' }, cookie: ann });
    expect(renamed.status).toBe(200);
    expect(renamed.body.board.name).toBe('Liftoff');
    expect((await api('DELETE', `/api/boards/${body.board.id}`, { cookie: ann })).status).toBe(204);
    expect((await api('GET', `/api/boards/${body.board.id}`, { cookie: ann })).status).toBe(404);
  });
});
