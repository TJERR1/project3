import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { q, readJson } from './db.js';
import { hashPassword, verifyPassword } from './password.js';

export const normaliseEmail = (e) => String(e ?? '').trim().toLowerCase();

function validateCredentials(body) {
  if (!body) return 'Invalid JSON body';
  const email = normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email.includes('@')) return 'Email must contain @';
  if (password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Secure is derived from the request itself rather than an env flag: an env
// var is a string, so `DEV=0` or `DEV=false` would silently disable Secure in
// production. Over https (every deployed Worker) the flag is always set; it is
// only omitted for plain-http local dev, where browsers would drop the cookie.
function cookieOptions(c) {
  const secure = new URL(c.req.url).protocol === 'https:';
  return { httpOnly: true, sameSite: 'Lax', path: '/', secure };
}

export async function requireAuth(c, next) {
  const sid = getCookie(c, 'sid');
  if (!sid) return c.json({ error: 'Not logged in' }, 401);
  const row = await q(
    c.get('db').from('sessions').select('id, users(id, email)').eq('id', sid).maybeSingle(),
  );
  if (!row || !row.users) return c.json({ error: 'Not logged in' }, 401);
  c.set('user', row.users);
  c.set('sessionId', row.id);
  await next();
}

export const authRoutes = new Hono();

authRoutes.post('/register', async (c) => {
  const body = await readJson(c);
  const problem = validateCredentials(body);
  if (problem) return c.json({ error: problem }, 400);
  const email = normaliseEmail(body.email);
  const password_hash = await hashPassword(body.password);
  try {
    const user = await q(
      c.get('db').from('users').insert({ email, password_hash }).select('id, email').single(),
    );
    return c.json({ user }, 201);
  } catch (err) {
    if (err.code === '23505') return c.json({ error: 'Email already registered' }, 409);
    throw err;
  }
});

authRoutes.post('/login', async (c) => {
  const body = await readJson(c);
  const problem = validateCredentials(body);
  if (problem) return c.json({ error: problem }, 400);
  const db = c.get('db');
  const user = await q(
    db.from('users').select('id, email, password_hash').eq('email', normaliseEmail(body.email)).maybeSingle(),
  );
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }
  const id = randomToken();
  await q(db.from('sessions').insert({ id, user_id: user.id }));
  setCookie(c, 'sid', id, cookieOptions(c));
  return c.json({ user: { id: user.id, email: user.email } });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  await q(c.get('db').from('sessions').delete().eq('id', c.get('sessionId')));
  deleteCookie(c, 'sid', { path: '/' });
  return c.body(null, 204);
});

authRoutes.get('/me', requireAuth, (c) => c.json({ user: c.get('user') }));
