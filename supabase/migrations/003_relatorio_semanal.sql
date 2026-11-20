-- 18/11/2026 — relatório semanal de presença por e-mail (Edge Function relatorio-semanal + pg_cron).
create extension if not exists pg_cron;
create extension if not exists pg_net;
alter table public.settings
  add column report_to        text not null default 'ricardomunhozpuc@gmail.com',  -- vários: separe por vírgula
  add column report_from      text not null default 'ricardomunhozpuc@gmail.com',  -- remetente verificado no Brevo
  add column report_from_name text not null default 'Plantão UTI';
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.cron_token (id int primary key default 1 check (id = 1), token text not null);
insert into private.cron_token (token) values (encode(gen_random_bytes(32), 'hex'));
create or replace function public.check_cron_token(p_token text) returns boolean
language sql stable security definer set search_path = private, public as $$
  select exists (select 1 from private.cron_token where token = p_token)
$$;
revoke execute on function public.check_cron_token(text) from public, anon, authenticated;
grant execute on function public.check_cron_token(text) to service_role;
-- Toda segunda 16:30 UTC = 13:30 em São Paulo (após o prazo de 6 h do check-out do noturno de domingo); período = semana anterior (seg–dom)
select cron.schedule('relatorio-semanal', '30 16 * * 1', $$
  select net.http_post(
    url := 'https://wyjivrrneqvrkmlncjbo.supabase.co/functions/v1/relatorio-semanal',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-token',(select token from private.cron_token)),
    body := '{}'::jsonb, timeout_milliseconds := 120000)
$$);
-- Segredo necessário em Edge Functions > Secrets: BREVO_API_KEY
