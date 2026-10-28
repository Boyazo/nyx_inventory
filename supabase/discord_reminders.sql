-- NYX Shift Bot: run the discord-reminders edge function every 15 minutes.
-- Run this once in Supabase Dashboard -> SQL Editor AFTER deploying the function and setting its secrets.
-- Replace PASTE_CRON_SECRET_HERE with the same value you set as the CRON_SECRET function secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'nyx-discord-shift-reminders';

select cron.schedule(
  'nyx-discord-shift-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://wdzrttyxcedkaifzkjvp.supabase.co/functions/v1/discord-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_CRON_SECRET_HERE'),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Check it's running:   select * from cron.job_run_details order by start_time desc limit 5;
-- Stop the bot:         select cron.unschedule('nyx-discord-shift-reminders');
