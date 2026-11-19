-- 19/11/2026 — Notificações Web Push (aplicado no projeto "Plantão UTI").
-- As chaves VAPID ficam só no banco (private.push_config). A chave PRIVADA não vai para o repositório:
-- para recriar, gere um par novo (npx web-push generate-vapid-keys), grave abaixo e ponha a pública em config.js.
create table private.push_config (id int primary key default 1 check (id = 1), public_key text not null, private_key text not null, subject text not null);
-- insert into private.push_config (public_key, private_key, subject) values ('<PUBLICA>', '<PRIVADA>', 'https://ricardomunhozpuc-cpu.github.io/plantao-uti/');
create or replace function public.get_push_config() returns json language sql stable security definer set search_path = private as $$
  select row_to_json(c) from private.push_config c where id = 1 $$;
revoke execute on function public.get_push_config() from public, anon, authenticated;
grant execute on function public.get_push_config() to service_role;

create table public.push_subscriptions (
  endpoint text primary key, doctor_id uuid not null references public.doctors(id) on delete cascade,
  p256dh text not null, auth text not null, ua text, created_at timestamptz not null default now());
create index push_subscriptions_doctor_idx on public.push_subscriptions(doctor_id);
alter table public.push_subscriptions enable row level security;   -- sem políticas: só via funções

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id();
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  if p_endpoint !~ '^https://' then raise exception 'Assinatura de notificação inválida.'; end if;
  insert into push_subscriptions (endpoint, doctor_id, p256dh, auth, ua) values (p_endpoint, v_me, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set doctor_id = excluded.doctor_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua;
end $$;
create or replace function public.delete_push_subscription(p_endpoint text) returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and doctor_id = my_doctor_id() $$;

create table private.notification_log (key text primary key, sent_at timestamptz not null default now());
create or replace function public.claim_notification(p_key text) returns boolean language plpgsql security definer set search_path = private as $$
begin insert into private.notification_log (key) values (p_key) on conflict do nothing; return found; end $$;
revoke execute on function public.claim_notification(text) from public, anon, authenticated;
grant execute on function public.claim_notification(text) to service_role;

create or replace function private.call_push(p_body jsonb) returns void language plpgsql security definer set search_path = private, public as $$
begin
  perform net.http_post(url := 'https://wyjivrrneqvrkmlncjbo.supabase.co/functions/v1/push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', (select token from private.cron_token)),
    body := p_body, timeout_milliseconds := 30000);
end $$;
create or replace function public.send_test_push() returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id();
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  perform private.call_push(jsonb_build_object('event', 'test', 'doctor_id', v_me));
end $$;
create or replace function private.swaps_notify() returns trigger language plpgsql security definer set search_path = private, public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    perform private.call_push(jsonb_build_object('event', 'swap', 'id', new.id, 'status', new.status, 'old_status', case when tg_op = 'UPDATE' then old.status end));
  end if;
  return null;
end $$;
create trigger swaps_notify after insert or update of status on public.swaps for each row execute function private.swaps_notify();

revoke execute on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.delete_push_subscription(text) from public, anon;
revoke execute on function public.send_test_push() from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
grant execute on function public.send_test_push() to authenticated;

select cron.schedule('push-lembretes', '*/5 * * * *', $$ select private.call_push('{"job":"tick"}'::jsonb) $$);
select cron.schedule('push-limpeza', '15 4 * * *', $$ delete from private.notification_log where sent_at < now() - interval '30 days' $$);
