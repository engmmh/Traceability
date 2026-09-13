-- =====================================================================
-- Row Level Security
-- Run once, after schema.sql.
--
-- The browser (GitHub Pages frontend) never talks to the database
-- directly — it only talks to the "inspection-api" Edge Function, which
-- authenticates with the Supabase *service role* key (server-side only).
-- RLS here exists as a safety net: even if the public/anon key ever leaked
-- or was used by mistake, it could not read or write these tables,
-- because the service role key bypasses RLS while the anon key does not.
-- =====================================================================

alter table branches       enable row level security;
alter table forms          enable row level security;
alter table form_branches  enable row level security;
alter table product_groups enable row level security;
alter table products       enable row level security;
alter table form_products  enable row level security;
alter table daily_runs     enable row level security;
alter table invoice_files  enable row level security;
alter table invoice_codes  enable row level security;
alter table daily_checks   enable row level security;
alter table product_dates  enable row level security;

-- No policies are defined on purpose: with RLS enabled and zero policies,
-- the anon/public key gets ZERO access. Only the service role key
-- (used exclusively inside the Edge Function) can read/write.
