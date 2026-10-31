-- Evening reminder schedule (alternative to Integrations → Cron in the dashboard).
-- Replace YOUR-PROJECT-REF, then run in SQL Editor. Calls the function every 5 minutes;
-- it sends at most one reminder a day, and only if today isn't finished.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ironclad-reminder',
  '*/5 * * * *',
  $$ select net.http_post(url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/ironclad/cron', body := '{}'::jsonb) $$
);
