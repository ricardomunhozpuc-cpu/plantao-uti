-- 19/11/2026 — Anúncio de plantão para todos.
-- Fluxo: plantonista anuncia (status 'aberta', sem colega) -> um colega elegível pega
-- (status 'gestor', to_doctor preenchido) -> gestor autoriza ou não.
-- Elegível: ativo, já entrou no app, trabalha no hospital do plantão e não está em outra UTI no turno.

alter table public.swaps alter column to_doctor drop not null;
alter table public.swaps drop constraint swaps_status_check;
alter table public.swaps add constraint swaps_status_check
  check (status in ('aberta','colega','gestor','aprovada','recusada','negada','cancelada'));
alter table public.swaps add constraint swaps_to_doctor_check
  check (to_doctor is not null or status in ('aberta','cancelada'));

-- Pedido direto: agora também bloqueia se o plantão estiver anunciado
create or replace function public.request_swap(p_shift text, p_to uuid, p_return text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_ret text := nullif(trim(coalesce(p_return,'')), ''); v_prob text; v_id uuid;
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  if p_to = v_me then raise exception 'Escolha outro colega.'; end if;
  if not exists (select 1 from doctors where id = p_to and active and user_id is not null) then
    raise exception 'O colega precisa ter entrado no app ao menos uma vez.';
  end if;
  perform 1 from shifts where id in (p_shift, coalesce(v_ret,'-')) order by id for update;
  if exists (select 1 from swaps where status in ('aberta','colega','gestor')
               and (shift_id in (p_shift, coalesce(v_ret,'-')) or return_shift_id in (p_shift, coalesce(v_ret,'-')))) then
    raise exception 'Já existe uma troca ou anúncio em andamento para um desses plantões.';
  end if;
  v_prob := _swap_problem(p_shift, v_ret, v_me, p_to);
  if v_prob is not null then raise exception '%', v_prob; end if;
  insert into swaps (shift_id, return_shift_id, from_doctor, to_doctor, note)
  values (p_shift, v_ret, v_me, p_to, nullif(left(trim(coalesce(p_note,'')), 280), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Anunciar o próprio plantão para todos
create or replace function public.announce_swap(p_shift text, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_sh shifts; v_id uuid;
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  select * into v_sh from shifts where id = p_shift for update;
  if not found or v_sh.doctor_id is distinct from v_me then raise exception 'Este plantão não está na sua escala.'; end if;
  if shift_start(p_shift) <= now() then raise exception 'Este plantão já começou.'; end if;
  if exists (select 1 from swaps where status in ('aberta','colega','gestor') and (shift_id = p_shift or return_shift_id = p_shift)) then
    raise exception 'Já existe uma troca ou anúncio em andamento para este plantão.';
  end if;
  insert into swaps (shift_id, from_doctor, to_doctor, note, status)
  values (p_shift, v_me, null, nullif(left(trim(coalesce(p_note,'')), 280), ''), 'aberta')
  returning id into v_id;
  return v_id;
end $$;

-- Pegar um plantão anunciado (vai direto para a autorização do gestor)
create or replace function public.take_swap(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_s swaps; v_prob text;
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  select * into v_s from swaps where id = p_id for update;
  if not found then raise exception 'Anúncio não encontrado.'; end if;
  if v_s.status <> 'aberta' then raise exception 'Este plantão já foi assumido por outro colega ou o anúncio foi encerrado.'; end if;
  if v_s.from_doctor = v_me then raise exception 'Este anúncio é seu.'; end if;
  perform 1 from shifts where id = v_s.shift_id for update;
  v_prob := _swap_problem(v_s.shift_id, null, v_s.from_doctor, v_me);
  if v_prob is not null then raise exception '%', replace(v_prob, 'O colega', 'Você'); end if;
  update swaps set to_doctor = v_me, status = 'gestor', colleague_at = now() where id = p_id;
end $$;

-- Cancelar: também vale para anúncio aberto
create or replace function public.cancel_swap(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_s swaps;
begin
  select * into v_s from swaps where id = p_id for update;
  if not found or v_me is null or v_s.from_doctor is distinct from v_me then raise exception 'Pedido não encontrado.'; end if;
  if v_s.status not in ('aberta','colega','gestor') then raise exception 'Este pedido já foi concluído.'; end if;
  update swaps set status = 'cancelada' where id = p_id;
end $$;

revoke execute on function public.announce_swap(text, text) from public, anon;
revoke execute on function public.take_swap(uuid) from public, anon;
grant execute on function public.announce_swap(text, text) to authenticated;
grant execute on function public.take_swap(uuid) to authenticated;

-- Encerra sozinho anúncios e pedidos sem resposta cujo plantão já começou (a cada 15 min)
select cron.schedule('trocas-expiradas', '*/15 * * * *', $$
  update public.swaps set status = 'cancelada'
   where status in ('aberta','colega') and public.shift_start(shift_id) <= now()
$$);
