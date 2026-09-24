import { Hono } from 'hono';
import { q, readJson, isUuid } from './db.js';

export const RANK = { viewer: 1, editor: 2, owner: 3 };
const BOARD_COLS = 'id, name, owner_id, created_at';

export function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) return 'Name is required';
  if (name.length > 200) return 'Name must be 200 characters or fewer';
  return null;
}

// Loads the caller's membership for :boardId. Non-member (or bad id) → 404,
// role below minRole → 403. Sets c.get('board') and c.get('role').
export function requireBoardRole(minRole) {
  return async (c, next) => {
    const boardId = c.req.param('boardId');
    if (!isUuid(boardId)) return c.json({ error: 'Board not found' }, 404);
    const row = await q(
      c.get('db')
        .from('board_members')
        .select(`role, boards(${BOARD_COLS})`)
        .eq('board_id', boardId)
        .eq('user_id', c.get('user').id)
        .maybeSingle(),
    );
    if (!row || !row.boards) return c.json({ error: 'Board not found' }, 404);
    if (RANK[row.role] < RANK[minRole]) return c.json({ error: 'Forbidden' }, 403);
    c.set('board', row.boards);
    c.set('role', row.role);
    await next();
  };
}

export async function loadMembers(db, boardId) {
  const rows = await q(
    db.from('board_members').select('user_id, role, users(email)').eq('board_id', boardId).order('role'),
  );
  return rows.map((r) => ({ user_id: r.user_id, email: r.users.email, role: r.role }));
}

export async function loadCards(db, boardId) {
  return q(
    db.from('cards').select('*').eq('board_id', boardId).order('column').order('position'),
  );
}

export const boardRoutes = new Hono();

boardRoutes.get('/', async (c) => {
  const rows = await q(
    c.get('db').from('board_members').select(`role, boards(${BOARD_COLS})`).eq('user_id', c.get('user').id),
  );
  const boards = rows
    .filter((r) => r.boards)
    .map((r) => ({ ...r.boards, role: r.role }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return c.json({ boards });
});

boardRoutes.post('/', async (c) => {
  const body = await readJson(c);
  const problem = validateName(body?.name);
  if (problem) return c.json({ error: problem }, 400);
  const db = c.get('db');
  const user = c.get('user');
  const board = await q(
    db.from('boards').insert({ name: body.name.trim(), owner_id: user.id }).select(BOARD_COLS).single(),
  );
  try {
    await q(db.from('board_members').insert({ board_id: board.id, user_id: user.id, role: 'owner' }));
  } catch (err) {
    await db.from('boards').delete().eq('id', board.id); // compensate; ignore its own error
    throw err;
  }
  return c.json({ board }, 201);
});

boardRoutes.get('/:boardId', requireBoardRole('viewer'), async (c) => {
  const db = c.get('db');
  const board = c.get('board');
  const [members, cards] = await Promise.all([loadMembers(db, board.id), loadCards(db, board.id)]);
  return c.json({ board, role: c.get('role'), members, cards });
});

boardRoutes.patch('/:boardId', requireBoardRole('owner'), async (c) => {
  const body = await readJson(c);
  const problem = validateName(body?.name);
  if (problem) return c.json({ error: problem }, 400);
  const board = await q(
    c.get('db').from('boards').update({ name: body.name.trim() }).eq('id', c.get('board').id).select(BOARD_COLS).single(),
  );
  return c.json({ board });
});

boardRoutes.delete('/:boardId', requireBoardRole('owner'), async (c) => {
  await q(c.get('db').from('boards').delete().eq('id', c.get('board').id));
  return c.body(null, 204);
});
