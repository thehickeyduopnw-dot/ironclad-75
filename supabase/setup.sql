-- Ironclad 75 cloud backend: run once in Supabase → SQL Editor.
-- Row Level Security is on with no policies, so the public "anon" key can read
-- nothing. Only the Edge Function (which uses the service role) can touch these.

create table if not exists public.days (
  date date primary key,
  day_number int,
  data jsonb not null,            -- the day exactly as the API returns it
  updated_at timestamptz not null default now()
);

create table if not exists public.kv (
  key text primary key,           -- progress, reminder, device, api_key, app_secret, reminder_last_sent
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.days enable row level security;
alter table public.kv enable row level security;
