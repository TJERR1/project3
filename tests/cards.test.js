import { describe, it, expect, beforeEach } from 'vitest';
import { api, resetDb, signup } from './helpers.js';

let ann, boardId;
beforeEach(async () => {
  await resetDb();
  ann = await signup('ann@example.com');
  boardId = (await api('POST', '/api/boards', { body: { name: 'Launch' }, cookie: ann })).body.board.id;
});

const cards = (path = '') => `/api/boards/${boardId}/cards${path}`;
const add = (title, column = 'todo') =>
  api('POST', cards(), { body: { title, description: `${title} desc`, column }, cookie: ann }).then((r) => r.body.card);
const layout = async () => {
  const r = await api('GET', `/api/boards/${boardId}`, { cookie: ann });
  return r.body.cards.map((c) => `${c.column}:${c.position}:${c.title}`);
};

describe('cards', () => {
  it('creates cards appended to the end of the column', async () => {
    const r = await api('POST', cards(), { body: { title: 'A', description: 'first', column: 'todo' }, cookie: ann });
    expect(r.status).toBe(201);
    expect(r.body.card).toMatchObject({ board_id: boardId, column: 'todo', position: 0, title: 'A', description: 'first' });
    await add('B');
    await add('C', 'doing');
    expect(await layout()).toEqual(['doing:0:C', 'todo:0:A', 'todo:1:B']);
  });

  it('validates input', async () => {
    expect((await api('POST', cards(), { body: { title: '', column: 'todo' }, cookie: ann })).status).toBe(400);
    expect((await api('POST', cards(), { body: { title: 'x'.repeat(201), column: 'todo' }, cookie: ann })).status).toBe(400);
    expect((await api('POST', cards(), { body: { title: 'A', column: 'later' }, cookie: ann })).status).toBe(400);
    expect((await api('POST', cards(), { rawBody: '[', cookie: ann })).status).toBe(400);
  });

  it('description defaults to empty', async () => {
    const r = await api('POST', cards(), { body: { title: 'A', column: 'todo' }, cookie: ann });
    expect(r.body.card.description).toBe('');
  });

  it('edits title and description', async () => {
    const a = await add('A');
    const r = await api('PATCH', cards(`/${a.id}`), { body: { title: 'A2', description: 'new' }, cookie: ann });
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ title: 'A2', description: 'new', column: 'todo', position: 0 });
  });

  it('moves a card to another column and renumbers both', async () => {
    const a = await add('A');
    await add('B');
    await add('C');
    await add('X', 'doing');
    const r = await api('PATCH', cards(`/${a.id}`), { body: { column: 'doing', position: 0 }, cookie: ann });
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ column: 'doing', position: 0 });
    expect(await layout()).toEqual(['doing:0:A', 'doing:1:X', 'todo:0:B', 'todo:1:C']);
  });

  it('reorders within a column', async () => {
    const a = await add('A');
    await add('B');
    await add('C');
    await api('PATCH', cards(`/${a.id}`), { body: { position: 2 }, cookie: ann });
    expect(await layout()).toEqual(['todo:0:B', 'todo:1:C', 'todo:2:A']);
  });

  it('clamps an oversized position to the end', async () => {
    const a = await add('A');
    await add('B');
    await api('PATCH', cards(`/${a.id}`), { body: { column: 'done', position: 99 }, cookie: ann });
    expect(await layout()).toEqual(['done:0:A', 'todo:0:B']);
  });

  it('rejects bad column or negative position without changing anything', async () => {
    const a = await add('A');
    await add('B');
    expect((await api('PATCH', cards(`/${a.id}`), { body: { column: 'later' }, cookie: ann })).status).toBe(400);
    expect((await api('PATCH', cards(`/${a.id}`), { body: { position: -1 }, cookie: ann })).status).toBe(400);
    expect((await api('PATCH', cards(`/${a.id}`), { body: { position: 1.5 }, cookie: ann })).status).toBe(400);
    expect(await layout()).toEqual(['todo:0:A', 'todo:1:B']);
  });

  it('deletes a card and closes the gap', async () => {
    const a = await add('A');
    await add('B');
    expect((await api('DELETE', cards(`/${a.id}`), { cookie: ann })).status).toBe(204);
    expect(await layout()).toEqual(['todo:0:B']);
  });

  it('returns 404 for unknown or non-uuid card ids', async () => {
    expect((await api('PATCH', cards('/nope'), { body: { title: 'x' }, cookie: ann })).status).toBe(404);
    expect((await api('DELETE', cards('/00000000-0000-0000-0000-000000000000'), { cookie: ann })).status).toBe(404);
  });
});
