import { describe, it, expect, beforeEach } from 'vitest';
import { api, resetDb, signup } from './helpers.js';

let owner, editor, viewer, stranger, boardA, boardB, cardA, cardB, viewerId;

beforeEach(async () => {
  await resetDb();
  owner = await signup('owner@example.com');
  editor = await signup('editor@example.com');
  viewer = await signup('viewer@example.com');
  stranger = await signup('stranger@example.com');
  boardA = (await api('POST', '/api/boards', { body: { name: 'A' }, cookie: owner })).body.board.id;
  boardB = (await api('POST', '/api/boards', { body: { name: 'B' }, cookie: stranger })).body.board.id;
  await api('POST', `/api/boards/${boardA}/members`, { body: { email: 'editor@example.com', role: 'editor' }, cookie: owner });
  await api('POST', `/api/boards/${boardA}/members`, { body: { email: 'viewer@example.com', role: 'viewer' }, cookie: owner });
  cardA = (await api('POST', `/api/boards/${boardA}/cards`, { body: { title: 'a', column: 'todo' }, cookie: owner })).body.card.id;
  cardB = (await api('POST', `/api/boards/${boardB}/cards`, { body: { title: 'b', column: 'todo' }, cookie: stranger })).body.card.id;
  viewerId = (await api('GET', '/api/auth/me', { cookie: viewer })).body.user.id;
});

const A = (p = '') => `/api/boards/${boardA}${p}`;

describe('viewer', () => {
  it('can read but not write cards', async () => {
    expect((await api('GET', A(), { cookie: viewer })).status).toBe(200);
    expect((await api('POST', A('/cards'), { body: { title: 'x', column: 'todo' }, cookie: viewer })).status).toBe(403);
    expect((await api('PATCH', A(`/cards/${cardA}`), { body: { title: 'x' }, cookie: viewer })).status).toBe(403);
    expect((await api('DELETE', A(`/cards/${cardA}`), { cookie: viewer })).status).toBe(403);
  });
});

describe('editor', () => {
  it('can write cards but not manage the board or members', async () => {
    expect((await api('POST', A('/cards'), { body: { title: 'x', column: 'todo' }, cookie: editor })).status).toBe(201);
    expect((await api('PATCH', A(), { body: { name: 'x' }, cookie: editor })).status).toBe(403);
    expect((await api('DELETE', A(), { cookie: editor })).status).toBe(403);
    expect((await api('POST', A('/members'), { body: { email: 'stranger@example.com', role: 'viewer' }, cookie: editor })).status).toBe(403);
    expect((await api('PATCH', A(`/members/${viewerId}`), { body: { role: 'editor' }, cookie: editor })).status).toBe(403);
    expect((await api('DELETE', A(`/members/${viewerId}`), { cookie: editor })).status).toBe(403);
  });
});

describe('non-member', () => {
  it('gets 404 on every board route', async () => {
    const s = { cookie: stranger };
    expect((await api('GET', A(), s)).status).toBe(404);
    expect((await api('PATCH', A(), { body: { name: 'x' }, ...s })).status).toBe(404);
    expect((await api('DELETE', A(), s)).status).toBe(404);
    expect((await api('GET', A('/members'), s)).status).toBe(404);
    expect((await api('POST', A('/members'), { body: { email: 'x@x.x', role: 'viewer' }, ...s })).status).toBe(404);
    expect((await api('POST', A('/cards'), { body: { title: 'x', column: 'todo' }, ...s })).status).toBe(404);
    expect((await api('PATCH', A(`/cards/${cardA}`), { body: { title: 'x' }, ...s })).status).toBe(404);
    expect((await api('DELETE', A(`/cards/${cardA}`), s)).status).toBe(404);
  });
});

describe('cross-board isolation', () => {
  it('a member of A cannot touch a card that belongs to B via A', async () => {
    expect((await api('PATCH', A(`/cards/${cardB}`), { body: { title: 'hijack' }, cookie: owner })).status).toBe(404);
    expect((await api('DELETE', A(`/cards/${cardB}`), { cookie: owner })).status).toBe(404);
    const b = await api('GET', `/api/boards/${boardB}`, { cookie: stranger });
    expect(b.body.cards[0].title).toBe('b');
  });

  it('board detail never includes another board\'s cards or members', async () => {
    const a = await api('GET', A(), { cookie: owner });
    expect(a.body.cards.map((c) => c.board_id)).toEqual([boardA]);
    expect(a.body.members.map((m) => m.email)).not.toContain('stranger@example.com');
  });
});
