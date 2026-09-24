import { Hono } from 'hono';
import { createDb } from './db.js';
import { authRoutes } from './auth.js';

export const app = new Hono();

app.use('/api/*', async (c, next) => {
  c.set('db', createDb(c.env));
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/api/auth', authRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
