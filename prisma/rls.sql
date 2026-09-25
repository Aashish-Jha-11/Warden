-- Row Level Security for Warden.
--
-- WHY THIS EXISTS, and why there are no policies in it.
--
-- Supabase exposes every table in `public` over PostgREST at
-- https://<ref>.supabase.co/rest/v1/<table>, authorised by the anon key. That
-- key is NEXT_PUBLIC_ and therefore ships inside the browser bundle. Without
-- RLS, anyone who loads the site can read every tenant's leads, phone numbers,
-- message bodies and audit log with a single curl. Verified: all four tables
-- returned 200 with data before this ran.
--
-- Warden never talks to PostgREST. Every read and write goes through Prisma,
-- server-side, as the table owner, and tenant scoping is enforced in the query.
-- So the correct fix is to enable RLS and grant NOTHING: with RLS on and no
-- permissive policy, the anon and authenticated roles can see zero rows, while
-- the owning role Prisma connects as is unaffected (owners bypass RLS unless
-- FORCE is set, which we deliberately do not set - forcing it would lock the
-- application out of its own database).
--
-- If a future version ever queries Supabase from the browser, this file is
-- where the per-tenant policies go. Until then, closed is the right default.

ALTER TABLE public.tenants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_steps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposed_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_runs         ENABLE ROW LEVEL SECURITY;

-- Defence in depth: even if a policy is added carelessly later, these roles
-- have no table privileges to exercise it with.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
