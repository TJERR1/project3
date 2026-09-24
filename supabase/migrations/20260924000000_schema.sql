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
