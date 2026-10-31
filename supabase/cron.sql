-- Evening reminder schedule. Replace YOUR-PROJECT-REF, then run in SQL Editor.
-- Calls the function every 5 minutes; it sends at most one reminder a day, and only if
-- today isn't finished. The database makes its own random cron secret (nobody ever
-- sees or types it); the job sends it and the function checks it, so the URL alone
-- can't trigger the reminder check.

create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.kv (key, value)
values ('cron_secret', jsonb_build_object('secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')))
on conflict (key) do nothing;

select cron.unschedule(jobid) from cron.job where jobname = 'ironclad-reminder';

select cron.schedule(
  'ironclad-reminder',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/ironclad/cron',
       body := '{}'::jsonb,
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'X-Cron-Secret', (select value->>'secret' from public.kv where key = 'cron_secret'))
     ) $$
);
