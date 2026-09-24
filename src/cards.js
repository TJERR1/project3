import { Hono } from 'hono';
import { q, readJson, isUuid } from './db.js';
import { requireBoardRole, loadCards } from './boards.js';

export const COLUMNS = ['todo', 'doing', 'done'];

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) return 'Title is required';
  if (title.length > 200) return 'Title must be 200 characters or fewer';
  return null;
}

const isPosition = (p) => Number.isInteger(p) && p >= 0;

async function findCard(db, boardId, cardId) {
  if (!isUuid(cardId)) return null;
  return q(db.from('cards').select('*').eq('board_id', boardId).eq('id', cardId).maybeSingle());
}

// Renumber the columns of `boardId` so that `card` (already patched with its
// new column) sits at `toPosition` and every other position is contiguous.
async function placeCard(db, boardId, card, toPosition) {
  const all = await loadCards(db, boardId);
  const byColumn = Object.fromEntries(COLUMNS.map((col) => [col, []]));
  for (const c of all) if (c.id !== card.id) byColumn[c.column].push(c);
  const target = byColumn[card.column];
  const idx = Math.min(toPosition, target.length);
  target.splice(idx, 0, card);
  const rows = COLUMNS.flatMap((col) => byColumn[col].map((c, i) => ({ ...c, position: i })));
  await q(db.from('cards').upsert(rows));
}

export const cardRoutes = new Hono();

cardRoutes.post('/:boardId/cards', requireBoardRole('editor'), async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  const problem = validateTitle(body.title);
  if (problem) return c.json({ error: problem }, 400);
  if (!COLUMNS.includes(body.column)) return c.json({ error: 'Column must be todo, doing or done' }, 400);
  const description = typeof body.description === 'string' ? body.description : '';
  const db = c.get('db');
  const boardId = c.get('board').id;
  const last = await q(
    db.from('cards').select('position').eq('board_id', boardId).eq('column', body.column)
      .order('position', { ascending: false }).limit(1).maybeSingle(),
  );
  const card = await q(
    db.from('cards')
      .insert({ board_id: boardId, column: body.column, position: last ? last.position + 1 : 0, title: body.title.trim(), description })
      .select('*')
      .single(),
  );
  return c.json({ card }, 201);
});

cardRoutes.patch('/:boardId/cards/:cardId', requireBoardRole('editor'), async (c) => {
  const db = c.get('db');
  const boardId = c.get('board').id;
  const card = await findCard(db, boardId, c.req.param('cardId'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  const body = await readJson(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const patch = {};
  if ('title' in body) {
    const problem = validateTitle(body.title);
    if (problem) return c.json({ error: problem }, 400);
    patch.title = body.title.trim();
  }
  if ('description' in body) {
    if (typeof body.description !== 'string') return c.json({ error: 'Description must be a string' }, 400);
    patch.description = body.description;
  }
  if ('column' in body && !COLUMNS.includes(body.column)) return c.json({ error: 'Column must be todo, doing or done' }, 400);
  if ('position' in body && !isPosition(body.position)) return c.json({ error: 'Position must be a non-negative integer' }, 400);

  const moving = 'column' in body || 'position' in body;
  if (moving) {
    const moved = { ...card, ...patch, column: body.column ?? card.column };
    const toPosition = 'position' in body ? body.position : (moved.column === card.column ? card.position : Number.MAX_SAFE_INTEGER);
    await placeCard(db, boardId, moved, toPosition);
  } else if (Object.keys(patch).length > 0) {
    await q(db.from('cards').update(patch).eq('board_id', boardId).eq('id', card.id));
  }
  const updated = await findCard(db, boardId, card.id);
  return c.json({ card: updated });
});

cardRoutes.delete('/:boardId/cards/:cardId', requireBoardRole('editor'), async (c) => {
  const db = c.get('db');
  const boardId = c.get('board').id;
  const card = await findCard(db, boardId, c.req.param('cardId'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  await q(db.from('cards').delete().eq('board_id', boardId).eq('id', card.id));
  const rest = (await loadCards(db, boardId)).filter((x) => x.column === card.column);
  const rows = rest.map((x, i) => ({ ...x, position: i })).filter((x, i) => x.position !== rest[i].position);
  if (rows.length > 0) await q(db.from('cards').upsert(rows));
  return c.body(null, 204);
});
