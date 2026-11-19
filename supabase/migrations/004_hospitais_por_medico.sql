-- 19/11/2026 — Plantonista vinculado a hospitais.
-- Regra: médico SEM vínculo trabalha em todos os hospitais; com vínculo, só nos marcados.
-- Plantonista vê a escala só dos seus hospitais (+ os próprios plantões) e só troca com
-- colegas que trabalham no hospital do plantão. Gestor vê tudo.

create table public.doctor_hospitals (
  doctor_id   uuid not null references public.doctors(id) on delete cascade,
  hospital_id text not null references public.hospitals(id) on delete cascade,
  primary key (doctor_id, hospital_id)
);
create index doctor_hospitals_hosp_idx on public.doctor_hospitals(hospital_id);
alter table public.doctor_hospitals enable row level security;
create policy team_read on public.doctor_hospitals for select to authenticated using ((select my_doctor_id()) is not null);
create policy manager_insert on public.doctor_hospitals for insert to authenticated with check ((select i_am_manager()));
create policy manager_delete on public.doctor_hospitals for delete to authenticated using ((select i_am_manager()));

create or replace function public.doctor_works_at(p_doc uuid, p_hosp text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from doctor_hospitals where doctor_id = p_doc)
      or exists (select 1 from doctor_hospitals where doctor_id = p_doc and hospital_id = p_hosp)
$$;

-- UTIs cuja escala o usuário logado pode ver
create or replace function public.my_units() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(u.id), '{}') from units u
   where i_am_manager() or doctor_works_at(my_doctor_id(), u.hospital_id)
$$;

drop policy team_read on public.shifts;
create policy team_read on public.shifts for select to authenticated using (
  (select my_doctor_id()) is not null and (
    (select i_am_manager()) or doctor_id = (select my_doctor_id()) or unit_id in (select unnest(my_units()))));

drop policy team_read on public.swaps;
create policy team_read on public.swaps for select to authenticated using (
  (select my_doctor_id()) is not null and (
    (select i_am_manager()) or from_doctor = (select my_doctor_id()) or to_doctor = (select my_doctor_id())
    or split_part(shift_id, '_', 3) in (select unnest(my_units()))));

-- Regra de trocas: colega precisa trabalhar no hospital do plantão
create or replace function public._swap_problem(p_shift text, p_return text, p_from uuid, p_to uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_a shifts; v_b shifts;
begin
  if not exists (select 1 from doctors where id = p_from and active) then
    return 'Quem pediu a troca não está mais ativo na equipe.';
  end if;
  if not exists (select 1 from doctors where id = p_to and active) then
    return 'O colega não está mais ativo na equipe.';
  end if;
  select * into v_a from shifts where id = p_shift;
  if v_a.doctor_id is distinct from p_from then
    return 'O plantão oferecido não está mais com quem pediu a troca.';
  end if;
  if shift_start(p_shift) <= now() then return 'O plantão oferecido já começou.'; end if;
  if not doctor_works_at(p_to, (select hospital_id from units where id = v_a.unit_id)) then
    return 'O colega não trabalha no hospital do plantão oferecido.';
  end if;
  if exists (select 1 from shifts where date = v_a.date and turn = v_a.turn
               and unit_id <> v_a.unit_id and doctor_id = p_to) then
    return 'O colega já está escalado em outra UTI nesse turno.';
  end if;
  if p_return is not null then
    select * into v_b from shifts where id = p_return;
    if v_b.doctor_id is distinct from p_to then
      return 'O plantão de retorno não está mais com o colega.';
    end if;
    if shift_start(p_return) <= now() then return 'O plantão de retorno já começou.'; end if;
    if v_a.date = v_b.date and v_a.turn = v_b.turn then
      return 'Os dois plantões são no mesmo turno.';
    end if;
    if not doctor_works_at(p_from, (select hospital_id from units where id = v_b.unit_id)) then
      return 'Quem pediu a troca não trabalha no hospital do plantão de retorno.';
    end if;
    if exists (select 1 from shifts where date = v_b.date and turn = v_b.turn
                 and unit_id <> v_b.unit_id and doctor_id = p_from) then
      return 'Quem pediu a troca já está escalado em outra UTI no turno de retorno.';
    end if;
  end if;
  return null;
end $$;

revoke execute on function public._swap_problem(text, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.doctor_works_at(uuid, text) from public, anon;
revoke execute on function public.my_units() from public, anon;
grant execute on function public.doctor_works_at(uuid, text) to authenticated;
grant execute on function public.my_units() to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.doctor_hospitals;
  end if;
end $$;
