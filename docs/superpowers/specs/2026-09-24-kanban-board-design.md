# Kanban Board with Shared Access — Design

Date: 2026-09-24 (revised for Cloudflare Workers + Supabase)

## Purpose

A to-do kanban board for a small team. Users register themselves, create
boards, and share boards with teammates. A board owner controls who can
edit and who can only view. Permissions are enforced on the server.

Success criterion: two users in separate browsers can each log in, one
shares a board with the other, and the server rejects any action the
second user's role does not allow.

## Scope

In version one:

- Register, log in, log out.
- Create, rename, delete boards.
- Add and remove board members with a role of editor or viewer.
- Fixed columns: `todo`, `doing`, `done`.
- Cards with title and description. Create, edit, delete, move between
  columns, reorder within a column.

Out of scope: custom columns, assignees, due dates, password reset,
email, admin role, Supabase Auth, RLS *policies* (RLS itself must stay
enabled; see Data model).

## Stack

- **Runtime:** a single Cloudflare Worker, deployed with Wrangler. It
  serves the static front end from `public/` via the Workers static
  assets binding and handles `/api/*` in code.
- **Framework:** Hono. Express-like routing and middleware, runs
  natively on Workers.
- **Database:** Supabase Postgres, accessed from the Worker with
  `@supabase/supabase-js` using the **service role key**, which bypasses
  Row Level Security. RLS is enabled on all app tables with no policies,
  so the public anon key gets nothing. The Worker is the only client
  and the only gate. The browser never talks to Supabase directly and
  never sees any Supabase key.
- **Password hashing:** PBKDF2-SHA256 via the Web Crypto API, 100 000
  iterations, 16-byte random salt. Native in Workers and within the CPU
  budget. Stored as `pbkdf2$<iterations>$<salt-hex>$<hash-hex>`.
- **Front end:** vanilla HTML, CSS, and JS in `public/`. No build step.
- **Tests:** `vitest` with `@cloudflare/vitest-pool-workers`, driving
  the Hono app through `app.request()` against a local Supabase
  database started by the Supabase CLI.

Commands: `npm run dev` (Wrangler dev server), `npm test`,
`npm run deploy`.

## Structure

```
package.json
wrangler.toml            worker name, assets binding, compatibility date
.dev.vars                local secrets (git-ignored)
supabase/
  config.toml            Supabase CLI config for local Postgres
  migrations/
    0001_schema.sql      tables below
src/
  index.js               creates the Hono app, exports the fetch handler
  app.js                 builds the app given a Supabase client (for tests)
  db.js                  createClient(url, serviceKey) helper
  auth.js                register, login, logout, me, requireAuth middleware
  boards.js              board CRUD, membership routes, requireBoardRole middleware
  cards.js               card CRUD and moves
  password.js            hash(password), verify(password, stored)
public/
  index.html             single page: login/register view, board list, board view
  app.js                 fetch calls to /api, renders views, drag and drop
  style.css
tests/
  helpers.js             builds app with test client, truncates tables between tests
  auth.test.js, boards.test.js, cards.test.js, access.test.js
```

## Configuration

Secrets are read from the Worker environment (`c.env` in Hono):

```
SUPABASE_URL          project URL
SUPABASE_SERVICE_KEY  service role key, never shipped to the browser
```

Locally these live in `.dev.vars`. In production they are set with
`wrangler secret put`. Tests point at the local Supabase instance
(`http://127.0.0.1:54321` and the local service key printed by
`supabase start`).

## Data model

Postgres, in `supabase/migrations/0001_schema.sql`:

```
users          id uuid pk default gen_random_uuid(), email text unique not null,
               password_hash text not null, created_at timestamptz default now()
sessions       id text pk (32-byte random hex), user_id uuid references users on delete cascade,
               created_at timestamptz default now()
boards         id uuid pk, name text not null, owner_id uuid references users,
               created_at timestamptz default now()
board_members  board_id uuid references boards on delete cascade,
               user_id uuid references users on delete cascade,
               role text not null check (role in ('owner','editor','viewer')),
               primary key (board_id, user_id)
cards          id uuid pk, board_id uuid references boards on delete cascade,
               "column" text not null check ("column" in ('todo','doing','done')),
               position integer not null, title text not null, description text default '',
               created_at timestamptz default now()
```

Indexes: `sessions(user_id)`, `board_members(user_id)`,
`cards(board_id, "column", position)`.

RLS is **enabled with no policies** on every table, and all `anon` and
`authenticated` grants on the `public` schema are revoked (including
default privileges for future objects). Supabase exposes `public` through
PostgREST and the anon key is not a secret, so leaving RLS off would let
anyone read sessions and password hashes directly. The service role
bypasses RLS, so the Worker is unaffected. Every new table must enable RLS
too; `tests/rls.test.js` checks this.

Creating a board inserts the creator into `board_members` as `owner`.
`boards.owner_id` is kept for convenience but the members row is the
authority. A board has exactly one owner and ownership does not transfer.

## Authentication

- `POST /api/auth/register` hashes the password with PBKDF2 and inserts
  the user. Duplicate email returns 409.
- Login verifies the hash, inserts a `sessions` row with a 32-byte random
  hex token, and sets it as an `httpOnly`, `Secure`, `SameSite=Lax`
  cookie named `sid` with `Path=/`. Wrangler dev serves over HTTP, so
  `Secure` is omitted when `c.env.DEV` is set.
- `requireAuth` middleware reads the cookie, looks up the session joined
  to the user, and sets `c.set('user', ...)`. Missing or unknown session
  returns 401.
- Logout deletes the session row and clears the cookie.
- Sessions do not expire in version one.

## Access control

Role hierarchy: `viewer` < `editor` < `owner`.

`requireBoardRole(minRole)` middleware, applied to every route under
`/api/boards/:boardId`:

1. Load the caller's `board_members` row for `:boardId`.
2. No row: return 404 (do not reveal that the board exists).
3. Role below `minRole`: return 403.
4. Otherwise set `board` and `role` on the context and continue.

Permission table:

| Action                          | Minimum role |
|---------------------------------|--------------|
| View board and cards            | viewer       |
| Create, edit, move, delete card | editor       |
| Rename board                    | owner        |
| Delete board                    | owner        |
| Add, change, remove members     | owner        |

Additional rules:

- The owner cannot be removed or demoted.
- A member cannot be given the `owner` role.
- Members are added by email; unknown email returns 404.
- Non-owner members may leave a board themselves via
  `DELETE /api/boards/:id/members/me`.

The front end hides controls the role does not permit, but the Worker
is the real gate. Because the Worker uses the service role key, every
query in `boards.js` and `cards.js` must filter by the `board_id`
already authorised by the middleware; a query that forgets the filter is
a security bug, and the access tests exist to catch it.

## API

All under `/api`, JSON in and out. Errors return `{ "error": "message" }`.

```
POST   /auth/register        {email, password}   201 {user}
POST   /auth/login           {email, password}   200 {user}
POST   /auth/logout                              204
GET    /auth/me                                  200 {user} | 401

GET    /boards                                   boards the caller belongs to, with role
POST   /boards               {name}              201 {board}
GET    /boards/:id                               {board, role, members, cards}
PATCH  /boards/:id           {name}              owner
DELETE /boards/:id                               owner

GET    /boards/:id/members                       viewer
POST   /boards/:id/members   {email, role}       owner
PATCH  /boards/:id/members/:userId {role}        owner
DELETE /boards/:id/members/:userId               owner
DELETE /boards/:id/members/me                    any non-owner member

POST   /boards/:id/cards     {title, description, column}  editor, appended to column
PATCH  /boards/:id/cards/:cardId {title?, description?, column?, position?}  editor
DELETE /boards/:id/cards/:cardId                 editor
```

Moving a card is a `PATCH` with `column` and `position`. The Worker
reads the affected column(s), computes the new order in memory, and
writes the renumbered positions back with a single `upsert`. Concurrent
moves on the same board may briefly leave gaps; positions are only used
for ordering so this is acceptable in version one.

Validation: email must contain `@`, password at least 8 characters, card
and board titles non-empty and at most 200 characters. Bad input returns
400.

## Front end

One page, three views switched by client state:

1. **Auth view**: login form with a link to a register form.
2. **Board list**: boards with the caller's role, a create-board form.
3. **Board view**: three columns of cards. Editors see an add-card form
   per column, can drag cards between and within columns (HTML5 drag and
   drop), and click a card to edit or delete it. Owners also see a
   members panel to add, change, or remove members and a delete-board
   button. Non-owners see a leave-board button.

On load the page calls `GET /api/auth/me` to decide the starting view.
Every API error is shown in a small banner at the top. All requests use
`fetch` with `credentials: 'same-origin'`; the front end and API share
one origin so no CORS configuration is needed.

## Error handling

- 400 validation, 401 not logged in, 403 insufficient role, 404 not
  found or not a member, 409 duplicate email.
- Supabase client errors are logged with `console.error` (visible in
  `wrangler tail`) and returned as 500 with a generic message. A Hono
  `onError` handler does this centrally.

## Testing

`npm test` expects a local Supabase running (`supabase start`). Each
test file builds the app with a client pointed at the local instance and
truncates all tables in `beforeEach`. Requests go through
`app.request(path, init, env)` so no network listener is needed. Tests
cover:

- Register, duplicate email, login with wrong password, session cookie
  grants access, logout revokes it.
- Board create, list scoped to membership, rename and delete by owner
  only.
- Member add by email, role change, removal, owner cannot be removed,
  leave board.
- Card create, edit, move with position renumbering, delete.
- Access matrix: viewer gets 403 on card writes, non-member gets 404 on
  every board route, editor gets 403 on member management, and a member
  of board A cannot read or modify a card belonging to board B by id.

## Deployment

1. Create a Supabase project and run `supabase db push` to apply the
   migration.
2. `wrangler secret put SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. `npm run deploy`. The Worker serves both the static assets and the
   API at the `workers.dev` URL or a custom domain.
