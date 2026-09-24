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
