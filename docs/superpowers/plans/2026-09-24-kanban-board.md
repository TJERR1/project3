# Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared to-do kanban board where users register, create boards, invite teammates as editors or viewers, and the server enforces every permission.

**Architecture:** One Cloudflare Worker runs a Hono app that serves `public/` as static assets and handles `/api/*`. The Worker talks to Supabase Postgres with the service role key and is the only client of the database, so all access control lives in Hono middleware. The front end is one vanilla JS page that calls the API with cookies.

**Tech Stack:** Hono 4, `@supabase/supabase-js` 2, Wrangler 4, Vitest 3, Supabase CLI (local Postgres via Docker), Web Crypto PBKDF2. Node 22.

**Spec:** `docs/superpowers/specs/2026-09-24-kanban-board-design.md`

## Global Constraints

- Runtime is a Cloudflare Worker. No Node-only APIs (`fs`, `bcrypt`, `better-sqlite3`) in `src/`.
- Database access only through `@supabase/supabase-js` with `SUPABASE_SERVICE_KEY`. The browser never receives any Supabase key.
- Row Level Security disabled on all tables; migration carries a comment saying so.
- Passwords hashed with PBKDF2-SHA256, 100 000 iterations, 16-byte salt, stored as `pbkdf2$<iterations>$<salt-hex>$<hash-hex>`.
- Session cookie: name `sid`, `httpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless `c.env.DEV` is set.
- Role rank: `viewer` < `editor` < `owner`. Non-member gets 404, insufficient role gets 403.
- Every board or card query filters by the `board_id` the middleware authorised.
- Validation: email must contain `@`, password ≥ 8 chars, titles non-empty and ≤ 200 chars. Bad input → 400. Errors are `{ "error": "message" }`.
- Columns are exactly `todo`, `doing`, `done`.
- No build step for the front end.

**Deviations from the spec, decided while planning (all minor):**
- Tests run in plain Vitest on Node 22 instead of the Workers pool. Everything `src/` uses (`fetch`, `Request`, `crypto.subtle`) is standard Web API present in both, and the Workers pool adds config friction with no test the plan needs.
- `boards.owner_id` gets `on delete cascade` so the test reset can delete all users in one call.
- Migration file is named `20260924000000_schema.sql` because the Supabase CLI expects a timestamp prefix.
- Emails are trimmed and lower-cased on register, login, and member add so `A@x.com` and `a@x.com` are one account.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task that owns the code.

1. Malformed JSON body on any POST/PATCH must return 400, not 500. (Task 3, `auth.test.js`)
2. Mixed-case or padded email must match the same account on login and member add. (Task 3, Task 5)
3. A board, card, or user id that is not a valid UUID must return 404, not a Postgres cast error as 500. (Task 4, Task 6)
4. Adding someone who is already a member, including the owner, must return 409, not 500. (Task 5)
5. Card PATCH with an unknown column or a negative position must return 400 and leave positions untouched. (Task 6)

---

### Task 1: Project scaffold, migration, and smoke test

**Files:**
- Create: `package.json`, `wrangler.toml`, `.gitignore`, `.dev.vars.example`, `vitest.config.js`
- Create: `supabase/migrations/20260924000000_schema.sql`
- Create: `src/index.js`, `src/app.js`, `src/db.js`
- Create: `tests/helpers.js`, `tests/smoke.test.js`
- Create: `public/index.html` (placeholder so the assets binding has a directory)

**Interfaces:**
- Produces: `app` (Hono instance) from `src/app.js`; `createDb(env)` and `q(builder)` from `src/db.js`; `env`, `api(method, path, opts)`, `resetDb()` from `tests/helpers.js`.

- [ ] **Step 1: Initialise git and npm**

```bash
cd D:/projects/tinkertanker/project3
git init
npm init -y
npm install hono @supabase/supabase-js
npm install -D wrangler vitest supabase
```

- [ ] **Step 2: Write `package.json` scripts and `.gitignore`**

Edit `package.json` so it contains:

```json
{
  "name": "kanban",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "db:start": "supabase start",
    "db:reset": "supabase db reset"
  }
}
```

Keep the `dependencies` and `devDependencies` npm added.

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
supabase/.temp/
supabase/.branches/
```

- [ ] **Step 3: Write `wrangler.toml` and `.dev.vars.example`**

`wrangler.toml`:

```toml
name = "kanban"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./public"
```

`.dev.vars.example` (committed; the real `.dev.vars` is git-ignored):

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_KEY=paste-the-service_role-key-printed-by-supabase-start
DEV=1
```

- [ ] **Step 4: Initialise Supabase and write the migration**

```bash
npx supabase init
```

Accept defaults. This creates `supabase/config.toml`. Then create `supabase/migrations/20260924000000_schema.sql`:

```sql
-- Row Level Security is intentionally DISABLED on every table.
-- The only database client is the Cloudflare Worker, which connects with the
-- service role key and enforces all access control in application code.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table sessions (
  id         text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index sessions_user_id on sessions(user_id);

create table boards (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table board_members (
  board_id uuid not null references boards(id) on delete cascade,
  user_id  uuid not null references users(id) on delete cascade,
  role     text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (board_id, user_id)
);
create index board_members_user_id on board_members(user_id);

create table cards (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references boards(id) on delete cascade,
  "column"    text not null check ("column" in ('todo', 'doing', 'done')),
  position    integer not null,
  title       text not null,
  description text not null default '',
  created_at  timestamptz not null default now()
);
create index cards_board_column_position on cards(board_id, "column", position);
```

- [ ] **Step 5: Start local Supabase and create `.dev.vars`**

```bash
npx supabase start
```

Requires Docker Desktop running. First run downloads images and takes a few minutes. The output ends with a block of keys. Copy `.dev.vars.example` to `.dev.vars` and paste the value labelled `service_role key` (older CLI) or `Secret key` (newer CLI) into `SUPABASE_SERVICE_KEY`. Confirm the migration applied:

```bash
npx supabase db reset
```

Expected: output ends with `Finished supabase db reset` and lists `20260924000000_schema.sql` as applied.

- [ ] **Step 6: Write `src/db.js`**

```js
import { createClient } from '@supabase/supabase-js';

export function createDb(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Await a supabase-js query builder and throw on error so the Hono onError
// handler turns it into a 500. Returns data only.
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// Parse a JSON body; returns null when the body is missing or malformed.
export async function readJson(c) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Write `src/app.js` and `src/index.js`**

`src/app.js`:

```js
import { Hono } from 'hono';
import { createDb } from './db.js';

export const app = new Hono();

app.use('/api/*', async (c, next) => {
  c.set('db', createDb(c.env));
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
```

`src/index.js`:

```js
import { app } from './app.js';

export default app;
```

`public/index.html` placeholder:

```html
<!doctype html>
<title>Kanban</title>
<p>Coming soon.</p>
```

- [ ] **Step 8: Write `vitest.config.js` and `tests/helpers.js`**

`vitest.config.js` (all test files share one database, so they must not run in parallel):

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { fileParallelism: false, include: ['tests/**/*.test.js'] },
});
```

`tests/helpers.js`:

```js
import fs from 'node:fs';
import { app } from '../src/app.js';
import { createDb } from '../src/db.js';

function loadDevVars() {
  const out = {};
  try {
    const text = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // no .dev.vars; rely on process.env
  }
  return out;
}

const vars = loadDevVars();
export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL ?? vars.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? vars.SUPABASE_SERVICE_KEY,
  DEV: '1',
};

// Deleting every user cascades to sessions, boards, board_members and cards.
export async function resetDb() {
  const db = createDb(env);
  const { error } = await db.from('users').delete().not('id', 'is', null);
  if (error) throw error;
}

// api('POST', '/api/auth/login', { body: {...}, cookie: 'sid=...' })
// api('POST', '/api/x', { rawBody: '{not json' }) sends the string as-is.
export async function api(method, path, { body, rawBody, cookie } = {}) {
  const headers = {};
  let payload;
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, { method, headers, body: payload }, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
}

// Registers then logs in; returns the session cookie string.
export async function signup(email, password = 'password123') {
  await api('POST', '/api/auth/register', { body: { email, password } });
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (!r.cookie) throw new Error(`signup failed for ${email}: ${r.status}`);
  return r.cookie;
}
```

- [ ] **Step 9: Write the smoke test**

`tests/smoke.test.js`:

```js
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
```

- [ ] **Step 10: Run tests**

Run: `npm test`
Expected: 3 passed. If the third test fails with a connection error, Supabase is not running (`npm run db:start`) or `.dev.vars` has the wrong key.

- [ ] **Step 11: Verify wrangler dev serves both halves**

Run: `npx wrangler dev` in one terminal, then in another:

```bash
curl -s http://localhost:8787/api/health
curl -s http://localhost:8787/ | head -3
```

Expected: `{"ok":true}` and the placeholder HTML. Stop wrangler.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold hono worker, supabase migration, test harness"
```

---

### Task 2: Password hashing

**Files:**
- Create: `src/password.js`
- Test: `tests/password.test.js`

**Interfaces:**
- Produces: `hashPassword(password) → Promise<string>` and `verifyPassword(password, stored) → Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`tests/password.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password', () => {
  it('produces the documented format', async () => {
    const h = await hashPassword('correct horse');
    const parts = h.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('100000');
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('salts, so two hashes of one password differ', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
  });

  it('rejects malformed stored values without throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/password.test.js`
Expected: FAIL, cannot find module `../src/password.js`.

- [ ] **Step 3: Implement `src/password.js`**

```js
const ITERATIONS = 100000;
const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, iter, saltHex, hashHex] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== 'pbkdf2' || !Number.isInteger(iterations) || !saltHex || !hashHex) return false;
  const computed = await derive(password, fromHex(saltHex), iterations);
  return constantTimeEqual(computed, hashHex);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/password.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/password.js tests/password.test.js
git commit -m "feat: pbkdf2 password hashing"
```

---

### Task 3: Authentication routes and requireAuth

**Files:**
- Create: `src/auth.js`
- Modify: `src/app.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` (Task 2); `q`, `readJson` (Task 1).
- Produces: `authRoutes` (Hono sub-app mounted at `/api/auth`); `requireAuth(c, next)` middleware which sets `c.get('user')` to `{ id, email }` and `c.get('sessionId')`.

- [ ] **Step 1: Write the failing tests**

`tests/auth.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auth.test.js`
Expected: FAIL, register returns 404.

- [ ] **Step 3: Implement `src/auth.js`**

```js
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

function cookieOptions(c) {
  return { httpOnly: true, sameSite: 'Lax', path: '/', secure: !c.env.DEV };
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
```

- [ ] **Step 4: Mount in `src/app.js`**

Add after the `/api/health` route:

```js
import { authRoutes } from './auth.js';
// ...
app.route('/api/auth', authRoutes);
```

(Put the import at the top of the file with the others.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/auth.test.js`
Expected: 9 passed. If `insert` with `.select()` on `sessions` complains, note the insert there has no `.select()` on purpose; `q` returns `null` data and that is fine.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js src/app.js tests/auth.test.js
git commit -m "feat: register, login, logout, session middleware"
```

---

### Task 4: Boards and the role middleware

**Files:**
- Create: `src/boards.js`
- Modify: `src/app.js`
- Test: `tests/boards.test.js`

**Interfaces:**
- Consumes: `requireAuth` (Task 3); `q`, `readJson`, `isUuid` (Task 1).
- Produces: `boardRoutes` (Hono sub-app mounted at `/api/boards`); `requireBoardRole(minRole)` middleware which sets `c.get('board')` to `{ id, name, owner_id, created_at }` and `c.get('role')`; `RANK` map.

- [ ] **Step 1: Write the failing tests**

`tests/boards.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/boards.test.js`
Expected: FAIL, routes return 404.

- [ ] **Step 3: Implement `src/boards.js`**

```js
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
  await q(db.from('board_members').insert({ board_id: board.id, user_id: user.id, role: 'owner' }));
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
```

- [ ] **Step 4: Mount in `src/app.js`**

```js
import { authRoutes, requireAuth } from './auth.js';
import { boardRoutes } from './boards.js';
// ... after the db middleware:
app.use('/api/boards', requireAuth);
app.use('/api/boards/*', requireAuth);
// ... after app.route('/api/auth', authRoutes):
app.route('/api/boards', boardRoutes);
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/boards.test.js`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add src/boards.js src/app.js tests/boards.test.js
git commit -m "feat: board crud and board role middleware"
```

---

### Task 5: Board membership

**Files:**
- Modify: `src/boards.js` (append routes)
- Test: `tests/members.test.js`

**Interfaces:**
- Consumes: `requireBoardRole`, `loadMembers` (Task 4); `normaliseEmail` (Task 3).
- Produces: the five `/api/boards/:boardId/members` routes from the spec.

- [ ] **Step 1: Write the failing tests**

`tests/members.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/members.test.js`
Expected: FAIL, member routes return 404.

- [ ] **Step 3: Append member routes to `src/boards.js`**

Add the import at the top:

```js
import { normaliseEmail } from './auth.js';
```

Append at the bottom. The `/me` route must be registered before `/:userId`:

```js
const MEMBER_ROLES = ['editor', 'viewer'];

boardRoutes.get('/:boardId/members', requireBoardRole('viewer'), async (c) =>
  c.json({ members: await loadMembers(c.get('db'), c.get('board').id) }),
);

boardRoutes.post('/:boardId/members', requireBoardRole('owner'), async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);
  if (!MEMBER_ROLES.includes(body.role)) return c.json({ error: 'Role must be editor or viewer' }, 400);
  const db = c.get('db');
  const user = await q(db.from('users').select('id, email').eq('email', normaliseEmail(body.email)).maybeSingle());
  if (!user) return c.json({ error: 'User not found' }, 404);
  try {
    await q(db.from('board_members').insert({ board_id: c.get('board').id, user_id: user.id, role: body.role }));
  } catch (err) {
    if (err.code === '23505') return c.json({ error: 'Already a member' }, 409);
    throw err;
  }
  return c.json({ member: { user_id: user.id, email: user.email, role: body.role } }, 201);
});

boardRoutes.delete('/:boardId/members/me', requireBoardRole('viewer'), async (c) => {
  if (c.get('role') === 'owner') return c.json({ error: 'Owner cannot leave the board' }, 403);
  await q(
    c.get('db').from('board_members').delete().eq('board_id', c.get('board').id).eq('user_id', c.get('user').id),
  );
  return c.body(null, 204);
});

boardRoutes.patch('/:boardId/members/:userId', requireBoardRole('owner'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) return c.json({ error: 'Member not found' }, 404);
  if (userId === c.get('board').owner_id) return c.json({ error: 'Cannot change the owner' }, 403);
  const body = await readJson(c);
  if (!body || !MEMBER_ROLES.includes(body.role)) return c.json({ error: 'Role must be editor or viewer' }, 400);
  const rows = await q(
    c.get('db')
      .from('board_members')
      .update({ role: body.role })
      .eq('board_id', c.get('board').id)
      .eq('user_id', userId)
      .select('user_id, role, users(email)'),
  );
  if (rows.length === 0) return c.json({ error: 'Member not found' }, 404);
  const r = rows[0];
  return c.json({ member: { user_id: r.user_id, email: r.users.email, role: r.role } });
});

boardRoutes.delete('/:boardId/members/:userId', requireBoardRole('owner'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) return c.json({ error: 'Member not found' }, 404);
  if (userId === c.get('board').owner_id) return c.json({ error: 'Cannot remove the owner' }, 403);
  const rows = await q(
    c.get('db').from('board_members').delete().eq('board_id', c.get('board').id).eq('user_id', userId).select('user_id'),
  );
  if (rows.length === 0) return c.json({ error: 'Member not found' }, 404);
  return c.body(null, 204);
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/members.test.js tests/boards.test.js`
Expected: all pass. If `DELETE /members/me` hits the `/:userId` handler instead (returns 404 "Member not found" for the owner test rather than 403), the `/me` route is registered after `/:userId`; move it up.

- [ ] **Step 5: Commit**

```bash
git add src/boards.js tests/members.test.js
git commit -m "feat: board membership management"
```

---

### Task 6: Cards

**Files:**
- Create: `src/cards.js`
- Modify: `src/app.js`
- Test: `tests/cards.test.js`

**Interfaces:**
- Consumes: `requireBoardRole`, `loadCards` (Task 4); `q`, `readJson`, `isUuid` (Task 1).
- Produces: `cardRoutes` (Hono sub-app mounted at `/api/boards`, paths `/:boardId/cards...`). Card shape: `{ id, board_id, column, position, title, description, created_at }`.

- [ ] **Step 1: Write the failing tests**

`tests/cards.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cards.test.js`
Expected: FAIL, card routes return 404.

- [ ] **Step 3: Implement `src/cards.js`**

```js
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
```

- [ ] **Step 4: Mount in `src/app.js`**

```js
import { cardRoutes } from './cards.js';
// ... after app.route('/api/boards', boardRoutes):
app.route('/api/boards', cardRoutes);
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/cards.test.js`
Expected: 10 passed. If `upsert` fails with a not-null violation, a row is missing a field; `loadCards` selects `*` so every row should be complete. PostgREST accepts `column` as a plain identifier in select strings and `.eq('column', ...)` filters, so no quoting is needed on the JS side; only the SQL migration quotes it.

- [ ] **Step 6: Commit**

```bash
git add src/cards.js src/app.js tests/cards.test.js
git commit -m "feat: card crud with column moves and renumbering"
```

---

### Task 7: Access matrix tests

**Files:**
- Test: `tests/access.test.js`

**Interfaces:**
- Consumes: everything above. No production code expected to change; this task exists to prove the permission table end to end and to catch any query missing a `board_id` filter.

- [ ] **Step 1: Write the tests**

`tests/access.test.js`:

```js
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
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: all files pass. Any failure here is a security bug in Tasks 4 to 6; fix it in the owning file, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/access.test.js
git commit -m "test: access control matrix"
```

---

### Task 8: Front end shell, auth view, and board list

**Files:**
- Replace: `public/index.html`
- Create: `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: `/api/auth/*` and `/api/boards` (list, create).
- Produces: `state`, `request()`, `render()`, `showError()`, `views` object in `public/app.js` that Task 9 extends with the board view.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kanban</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="topbar">
    <a href="#" id="home-link" class="brand">Kanban</a>
    <span id="whoami" class="muted"></span>
    <button id="logout-btn" class="ghost hidden">Log out</button>
  </header>
  <div id="error" class="banner hidden" role="alert"></div>

  <main id="view"></main>

  <template id="tpl-auth">
    <section class="card auth">
      <h1 data-title>Log in</h1>
      <form data-form>
        <label>Email <input name="email" type="email" required autocomplete="email"></label>
        <label>Password <input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
        <button type="submit" data-submit>Log in</button>
      </form>
      <p class="muted"><span data-switch-text>No account?</span> <a href="#" data-switch>Register</a></p>
    </section>
  </template>

  <template id="tpl-boards">
    <section>
      <h1>Your boards</h1>
      <form class="inline" data-create>
        <input name="name" placeholder="New board name" maxlength="200" required>
        <button type="submit">Create</button>
      </form>
      <ul class="board-list" data-list></ul>
    </section>
  </template>

  <template id="tpl-board">
    <section class="board">
      <div class="board-head">
        <a href="#" data-back>&larr; Boards</a>
        <h1 data-name></h1>
        <span class="pill" data-role></span>
        <span class="spacer"></span>
        <button class="ghost hidden" data-rename>Rename</button>
        <button class="ghost hidden" data-members-toggle>Members</button>
        <button class="ghost danger hidden" data-leave>Leave board</button>
        <button class="ghost danger hidden" data-delete>Delete board</button>
      </div>
      <aside class="members hidden" data-members-panel>
        <h2>Members</h2>
        <ul data-members-list></ul>
        <form class="inline" data-add-member>
          <input name="email" type="email" placeholder="teammate@example.com" required>
          <select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
          <button type="submit">Add</button>
        </form>
      </aside>
      <div class="columns" data-columns></div>
    </section>
  </template>

  <template id="tpl-column">
    <div class="column" data-column>
      <h2 data-heading></h2>
      <div class="cards" data-cards></div>
      <form class="add-card hidden" data-add-card>
        <input name="title" placeholder="Add a card" maxlength="200" required>
        <button type="submit">+</button>
      </form>
    </div>
  </template>

  <template id="tpl-card">
    <article class="kcard" draggable="false" data-card>
      <h3 data-title></h3>
      <p class="muted" data-desc></p>
    </article>
  </template>

  <dialog id="card-dialog">
    <form method="dialog" data-card-form>
      <h2>Edit card</h2>
      <label>Title <input name="title" maxlength="200" required></label>
      <label>Description <textarea name="description" rows="4"></textarea></label>
      <div class="dialog-actions">
        <button type="button" class="ghost danger" data-card-delete>Delete</button>
        <span class="spacer"></span>
        <button type="button" class="ghost" data-card-cancel>Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  </dialog>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
:root {
  --bg: #f4f5f7; --surface: #fff; --text: #172b4d; --muted: #6b778c;
  --line: #dfe1e6; --accent: #0052cc; --danger: #de350b; --radius: 8px;
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--text); }
.hidden { display: none !important; }
.muted { color: var(--muted); }
.spacer { flex: 1; }
a { color: var(--accent); text-decoration: none; }
button { font: inherit; padding: 6px 12px; border-radius: var(--radius); border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.ghost { background: transparent; color: var(--accent); }
button.danger { border-color: var(--danger); color: var(--danger); }
input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius); width: 100%; }
label { display: block; margin: 8px 0; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; color: var(--text); }
.banner { background: #ffebe6; color: var(--danger); padding: 8px 16px; }
main { padding: 16px; max-width: 1100px; margin: 0 auto; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }
.auth { max-width: 360px; margin: 48px auto; }
.inline { display: flex; gap: 8px; margin: 12px 0; }
.inline input { flex: 1; }
.board-list { list-style: none; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.board-list a { display: block; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; color: var(--text); }
.pill { font-size: 12px; background: var(--line); border-radius: 999px; padding: 2px 8px; text-transform: capitalize; }
.board-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.board-head h1 { margin: 0; font-size: 20px; }
.members { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; margin-bottom: 12px; }
.members ul { list-style: none; padding: 0; margin: 0; }
.members li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.members li select { width: auto; }
.columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.column { background: #ebecf0; border-radius: var(--radius); padding: 8px; min-height: 200px; }
.column h2 { font-size: 14px; margin: 4px 8px 8px; text-transform: uppercase; color: var(--muted); }
.column.drop-target { outline: 2px dashed var(--accent); }
.cards { display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
.kcard { background: var(--surface); border-radius: var(--radius); padding: 10px; box-shadow: 0 1px 1px rgba(9,30,66,.25); cursor: pointer; }
.kcard[draggable="true"] { cursor: grab; }
.kcard.dragging { opacity: .5; }
.kcard h3 { margin: 0 0 4px; font-size: 15px; }
.kcard p { margin: 0; font-size: 13px; white-space: pre-wrap; }
.add-card { display: flex; gap: 6px; margin-top: 8px; }
dialog { border: 1px solid var(--line); border-radius: var(--radius); width: min(480px, 90vw); }
.dialog-actions { display: flex; gap: 8px; margin-top: 12px; }
@media (max-width: 720px) { .columns { grid-template-columns: 1fr; } main { padding: 12px; } }
```

- [ ] **Step 3: Write `public/app.js` with auth and board list**

```js
/* Kanban front end. One page, three views: auth, boards, board. */

const state = { user: null, view: 'auth', boards: [], board: null, authMode: 'login' };

const $ = (sel, root = document) => root.querySelector(sel);
const tpl = (id) => $(`#${id}`).content.firstElementChild.cloneNode(true);

function showError(message) {
  const el = $('#error');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({ error: 'Bad response' }));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; go('auth'); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Wrap an async handler so any thrown error lands in the banner.
const guard = (fn) => (...args) => fn(...args).catch((e) => showError(e.message));

function go(view, data) {
  state.view = view;
  if (view === 'board') state.board = data;
  render();
}

const views = {};

views.auth = () => {
  const el = tpl('tpl-auth');
  const register = state.authMode === 'register';
  $('[data-title]', el).textContent = register ? 'Register' : 'Log in';
  $('[data-submit]', el).textContent = register ? 'Register' : 'Log in';
  $('[data-switch-text]', el).textContent = register ? 'Have an account?' : 'No account?';
  $('[data-switch]', el).textContent = register ? 'Log in' : 'Register';
  $('[data-switch]', el).onclick = (e) => { e.preventDefault(); state.authMode = register ? 'login' : 'register'; render(); };
  $('[data-form]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const creds = { email: f.get('email'), password: f.get('password') };
    if (register) await request('POST', '/api/auth/register', creds);
    const { user } = await request('POST', '/api/auth/login', creds);
    state.user = user;
    await loadBoards();
  });
  return el;
};

async function loadBoards() {
  const { boards } = await request('GET', '/api/boards');
  state.boards = boards;
  go('boards');
}

views.boards = () => {
  const el = tpl('tpl-boards');
  const list = $('[data-list]', el);
  for (const b of state.boards) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.innerHTML = `<strong></strong><br><span class="pill"></span>`;
    $('strong', a).textContent = b.name;
    $('.pill', a).textContent = b.role;
    a.onclick = guard(async (e) => { e.preventDefault(); await openBoard(b.id); });
    li.append(a);
    list.append(li);
  }
  $('[data-create]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    await request('POST', '/api/boards', { name: new FormData(e.target).get('name') });
    await loadBoards();
  });
  return el;
};

async function openBoard(id) {
  const data = await request('GET', `/api/boards/${id}`);
  go('board', data);
}

views.board = () => {
  const el = document.createElement('p');
  el.textContent = 'Board view comes in the next task.';
  return el;
};

function render() {
  $('#whoami').textContent = state.user ? state.user.email : '';
  $('#logout-btn').classList.toggle('hidden', !state.user);
  const view = $('#view');
  view.replaceChildren(views[state.view]());
}

$('#logout-btn').onclick = guard(async () => {
  await request('POST', '/api/auth/logout');
  state.user = null;
  state.authMode = 'login';
  go('auth');
});
$('#home-link').onclick = guard(async (e) => { e.preventDefault(); if (state.user) await loadBoards(); });

guard(async () => {
  try {
    const { user } = await request('GET', '/api/auth/me');
    state.user = user;
    await loadBoards();
  } catch {
    go('auth');
  }
})();
```

- [ ] **Step 4: Verify in the browser**

Run: `npx wrangler dev`, open `http://localhost:8787`.

Check, in order:
1. Register a new account → lands on "Your boards" with the email in the top bar.
2. Create a board → it appears with an "owner" pill.
3. Reload the page → still logged in (cookie survived).
4. Log out → back to the login form; reload stays on login.
5. Log in with the wrong password → red banner "Invalid email or password".
6. Click a board → placeholder text from `views.board`.

Stop wrangler.

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat: front end shell with auth and board list"
```

---

### Task 9: Front end board view with drag and drop and members

**Files:**
- Modify: `public/app.js` (replace `views.board`)
- Create: `README.md`

**Interfaces:**
- Consumes: `state.board` = `{ board, role, members, cards }` from `openBoard`; `request`, `guard`, `tpl`, `$`, `go`, `loadBoards`.

- [ ] **Step 1: Replace `views.board` in `public/app.js`**

Delete the placeholder `views.board` and insert:

```js
const COLUMNS = [['todo', 'To Do'], ['doing', 'Doing'], ['done', 'Done']];
const RANK = { viewer: 1, editor: 2, owner: 3 };

views.board = () => {
  const { board, role, members, cards } = state.board;
  const can = (min) => RANK[role] >= RANK[min];
  const el = tpl('tpl-board');
  const reload = () => openBoard(board.id);

  $('[data-name]', el).textContent = board.name;
  $('[data-role]', el).textContent = role;
  $('[data-back]', el).onclick = guard(async (e) => { e.preventDefault(); await loadBoards(); });

  // Owner controls
  if (can('owner')) {
    for (const sel of ['[data-rename]', '[data-members-toggle]', '[data-delete]']) $(sel, el).classList.remove('hidden');
    $('[data-rename]', el).onclick = guard(async () => {
      const name = prompt('Board name', board.name);
      if (name === null || name.trim() === '') return;
      await request('PATCH', `/api/boards/${board.id}`, { name });
      await reload();
    });
    $('[data-delete]', el).onclick = guard(async () => {
      if (!confirm(`Delete "${board.name}" and all its cards?`)) return;
      await request('DELETE', `/api/boards/${board.id}`);
      await loadBoards();
    });
    $('[data-members-toggle]', el).onclick = () => $('[data-members-panel]', el).classList.toggle('hidden');
  } else {
    $('[data-leave]', el).classList.remove('hidden');
    $('[data-leave]', el).onclick = guard(async () => {
      if (!confirm(`Leave "${board.name}"?`)) return;
      await request('DELETE', `/api/boards/${board.id}/members/me`);
      await loadBoards();
    });
  }

  // Members panel (owner only; the toggle is hidden for others)
  const memberList = $('[data-members-list]', el);
  for (const m of members) {
    const li = document.createElement('li');
    const email = document.createElement('span');
    email.textContent = m.email;
    li.append(email);
    if (m.role === 'owner') {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'owner';
      li.append(pill);
    } else {
      const select = document.createElement('select');
      for (const r of ['editor', 'viewer']) {
        const o = new Option(r, r, r === m.role, r === m.role);
        select.append(o);
      }
      select.onchange = guard(async () => {
        await request('PATCH', `/api/boards/${board.id}/members/${m.user_id}`, { role: select.value });
        await reload();
      });
      const remove = document.createElement('button');
      remove.className = 'ghost danger';
      remove.textContent = 'Remove';
      remove.onclick = guard(async () => {
        await request('DELETE', `/api/boards/${board.id}/members/${m.user_id}`);
        await reload();
      });
      li.append(select, remove);
    }
    memberList.append(li);
  }
  $('[data-add-member]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await request('POST', `/api/boards/${board.id}/members`, { email: f.get('email'), role: f.get('role') });
    await reload();
    $('[data-members-panel]', $('#view')).classList.remove('hidden');
  });

  // Columns and cards
  const columnsEl = $('[data-columns]', el);
  for (const [key, label] of COLUMNS) {
    const col = tpl('tpl-column');
    col.dataset.column = key;
    $('[data-heading]', col).textContent = label;
    const cardsEl = $('[data-cards]', col);
    for (const card of cards.filter((c) => c.column === key)) {
      const node = tpl('tpl-card');
      node.dataset.id = card.id;
      $('[data-title]', node).textContent = card.title;
      $('[data-desc]', node).textContent = card.description;
      if (can('editor')) {
        node.draggable = true;
        node.ondragstart = (e) => { e.dataTransfer.setData('text/plain', card.id); node.classList.add('dragging'); };
        node.ondragend = () => node.classList.remove('dragging');
        node.onclick = () => editCard(card, reload);
      }
      cardsEl.append(node);
    }
    if (can('editor')) {
      const form = $('[data-add-card]', col);
      form.classList.remove('hidden');
      form.onsubmit = guard(async (e) => {
        e.preventDefault();
        await request('POST', `/api/boards/${board.id}/cards`, { title: new FormData(e.target).get('title'), column: key });
        await reload();
      });
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop-target'); };
      col.ondragleave = () => col.classList.remove('drop-target');
      col.ondrop = guard(async (e) => {
        e.preventDefault();
        col.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        // Position = number of non-dragged cards whose vertical midpoint is above the pointer.
        const others = [...cardsEl.querySelectorAll('[data-card]')].filter((n) => n.dataset.id !== id);
        const position = others.filter((n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
        await request('PATCH', `/api/boards/${board.id}/cards/${id}`, { column: key, position });
        await reload();
      });
    }
    columnsEl.append(col);
  }
  return el;
};

function editCard(card, reload) {
  const dialog = $('#card-dialog');
  const form = $('[data-card-form]', dialog);
  form.elements.title.value = card.title;
  form.elements.description.value = card.description;
  const boardId = state.board.board.id;
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    await request('PATCH', `/api/boards/${boardId}/cards/${card.id}`, {
      title: form.elements.title.value,
      description: form.elements.description.value,
    });
    dialog.close();
    await reload();
  });
  $('[data-card-cancel]', dialog).onclick = () => dialog.close();
  $('[data-card-delete]', dialog).onclick = guard(async () => {
    await request('DELETE', `/api/boards/${boardId}/cards/${card.id}`);
    dialog.close();
    await reload();
  });
  dialog.showModal();
}
```

- [ ] **Step 2: Verify in the browser with two users**

Run: `npx wrangler dev`. Use a normal window for Ann and a private window for Bob.

1. Ann: open a board, add three cards to To Do, drag one to Doing, drag another above the first in To Do. Reload: order persists.
2. Ann: click a card, change title and description, Save. Click again, Delete.
3. Ann: Members → add Bob as viewer.
4. Bob: log in, open the board. No add-card forms, cards not draggable, no Members or Delete button, "Leave board" visible.
5. Ann: change Bob to editor. Bob reloads: can add and drag cards, still no Members button.
6. Bob: Leave board → back to board list, board gone.
7. Ann: Delete board → back to an empty board list.

Any step where the UI shows a control the role should not have, or the server returns an error the UI does not show, is a bug to fix before committing.

- [ ] **Step 3: Write `README.md`**

```markdown
# Kanban

Shared to-do kanban board. Cloudflare Worker (Hono) + Supabase Postgres.

## Local development

Requires Node 22 and Docker Desktop.

1. `npm install`
2. `npm run db:start` — starts local Supabase, applies `supabase/migrations`.
3. Copy `.dev.vars.example` to `.dev.vars` and paste the `service_role` key that `db:start` printed.
4. `npm run dev` — http://localhost:8787
5. `npm test`

## Deploy

1. Create a Supabase project. Link and push the schema:
   `npx supabase link --project-ref <ref>` then `npx supabase db push`.
2. `npx wrangler secret put SUPABASE_URL` and `npx wrangler secret put SUPABASE_SERVICE_KEY`
   (use the project's service_role key; it never reaches the browser).
3. `npm run deploy`

## Roles

| Action                          | Minimum role |
|---------------------------------|--------------|
| View board and cards            | viewer       |
| Create, edit, move, delete card | editor       |
| Rename or delete board          | owner        |
| Manage members                  | owner        |

Row Level Security is intentionally off; the Worker is the only database client and enforces these rules.
```

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add public/app.js README.md
git commit -m "feat: board view with drag and drop and member management"
```
