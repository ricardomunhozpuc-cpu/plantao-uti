-- 20/11/2026 — Aviso quando o gestor escala ou retira um médico pela aba Escala.
-- Gatilhos por comando (não por linha): um "Repetir semana" vira uma chamada só, e a função
-- de push agrupa os plantões por médico. Mudanças feitas por trocas autorizadas ou
-- redirecionadas não passam por aqui (já têm aviso próprio).

create or replace function private.shifts_notify_send(p_changes jsonb) returns void
language plpgsql security definer set search_path = private, public as $$
begin
  if coalesce(current_setting('app.skip_shift_notify', true), '') = '1' then return; end if;
  if p_changes is null or jsonb_array_length(p_changes) = 0 then return; end if;
  perform private.call_push(jsonb_build_object('event', 'shifts', 'by', public.my_doctor_id(), 'changes', p_changes));
end $$;

create or replace function private.shifts_notify_ins() returns trigger
language plpgsql security definer set search_path = private, public as $$
begin
  perform private.shifts_notify_send((select jsonb_agg(jsonb_build_object('shift', n.id, 'old', null, 'new', n.doctor_id))
                                        from new_rows n where n.doctor_id is not null));
  return null;
end $$;
create or replace function private.shifts_notify_upd() returns trigger
language plpgsql security definer set search_path = private, public as $$
begin
  perform private.shifts_notify_send((select jsonb_agg(jsonb_build_object('shift', n.id, 'old', o.doctor_id, 'new', n.doctor_id))
                                        from new_rows n join old_rows o on o.id = n.id
                                       where n.doctor_id is distinct from o.doctor_id));
  return null;
end $$;
create or replace function private.shifts_notify_del() returns trigger
language plpgsql security definer set search_path = private, public as $$
begin
  perform private.shifts_notify_send((select jsonb_agg(jsonb_build_object('shift', o.id, 'old', o.doctor_id, 'new', null))
                                        from old_rows o where o.doctor_id is not null));
  return null;
end $$;

create trigger shifts_notify_ins after insert on public.shifts referencing new table as new_rows
  for each statement execute function private.shifts_notify_ins();
create trigger shifts_notify_upd after update on public.shifts referencing old table as old_rows new table as new_rows
  for each statement execute function private.shifts_notify_upd();
create trigger shifts_notify_del after delete on public.shifts referencing old table as old_rows
  for each statement execute function private.shifts_notify_del();

-- Trocas autorizadas e redirecionamentos já avisam pelo gatilho de swaps: suprime o aviso de escala
create or replace function public.decide_swap(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_s swaps; v_prob text;
begin
  if not i_am_manager() then raise exception 'Apenas o gestor autoriza trocas.'; end if;
  select * into v_s from swaps where id = p_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if v_s.status <> 'gestor' then raise exception 'Este pedido não está aguardando autorização.'; end if;
  if p_approve then
    perform 1 from shifts where id in (v_s.shift_id, coalesce(v_s.return_shift_id,'-')) order by id for update;
    v_prob := _swap_problem(v_s.shift_id, v_s.return_shift_id, v_s.from_doctor, v_s.to_doctor);
    if v_prob is not null then raise exception 'A escala mudou desde o pedido: %', v_prob; end if;
    perform set_config('app.skip_shift_notify', '1', true);
    update shifts set doctor_id = v_s.to_doctor where id = v_s.shift_id;
    if v_s.return_shift_id is not null then
      update shifts set doctor_id = v_s.from_doctor where id = v_s.return_shift_id;
    end if;
    perform set_config('app.skip_shift_notify', '', true);
    update swaps set status = 'aprovada', decided_at = now(), decided_by = my_doctor_id() where id = p_id;
  else
    update swaps set status = 'negada', decided_at = now(), decided_by = my_doctor_id() where id = p_id;
  end if;
end $$;

create or replace function public.manager_redirect_swap(p_id uuid, p_doctor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_s swaps; v_sh shifts;
begin
  if not i_am_manager() then raise exception 'Apenas o gestor redireciona plantões.'; end if;
  select * into v_s from swaps where id = p_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if v_s.status not in ('gestor','aberta') then raise exception 'Este pedido não está mais em aberto.'; end if;
  select * into v_sh from shifts where id = v_s.shift_id for update;
  if v_sh.doctor_id is distinct from v_s.from_doctor then raise exception 'A escala mudou desde o pedido: o plantão não está mais com quem pediu a troca.'; end if;
  if shift_start(v_s.shift_id) <= now() then raise exception 'O plantão já começou.'; end if;
  if p_doctor = v_s.from_doctor then raise exception 'Escolha outro médico.'; end if;
  if not exists (select 1 from doctors where id = p_doctor and active and available) then
    raise exception 'O médico escolhido não está ativo ou não está apto a receber novos plantões.';
  end if;
  if exists (select 1 from shifts where date = v_sh.date and turn = v_sh.turn and unit_id <> v_sh.unit_id and doctor_id = p_doctor) then
    raise exception 'O médico escolhido já está escalado em outra UTI nesse turno.';
  end if;
  perform set_config('app.skip_shift_notify', '1', true);
  update shifts set doctor_id = p_doctor where id = v_s.shift_id;
  perform set_config('app.skip_shift_notify', '', true);
  update swaps set status = 'redirecionada', redirected_to = p_doctor, decided_at = now(), decided_by = my_doctor_id() where id = p_id;
end $$;
