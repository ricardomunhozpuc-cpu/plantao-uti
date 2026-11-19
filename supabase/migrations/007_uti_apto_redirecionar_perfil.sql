-- 19/11/2026 — Vínculo por UTI, médico apto/não apto, gestor redireciona plantão, cadastro de CRM e telefone.

-- 1) Vínculo por UTI (substitui o vínculo por hospital). Sem vínculo = trabalha em todas as UTIs.
create table public.doctor_units (
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  unit_id   text not null references public.units(id) on delete cascade,
  primary key (doctor_id, unit_id)
);
create index doctor_units_unit_idx on public.doctor_units(unit_id);
insert into public.doctor_units (doctor_id, unit_id)
  select dh.doctor_id, u.id from public.doctor_hospitals dh join public.units u on u.hospital_id = dh.hospital_id;
alter table public.doctor_units enable row level security;
create policy team_read on public.doctor_units for select to authenticated using ((select my_doctor_id()) is not null);
create policy manager_insert on public.doctor_units for insert to authenticated with check ((select i_am_manager()));
create policy manager_delete on public.doctor_units for delete to authenticated using ((select i_am_manager()));

create or replace function public.doctor_works_in(p_doc uuid, p_unit text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from doctor_units where doctor_id = p_doc)
      or exists (select 1 from doctor_units where doctor_id = p_doc and unit_id = p_unit)
$$;
create or replace function public.my_units() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(u.id), '{}') from units u
   where i_am_manager() or doctor_works_in(my_doctor_id(), u.id)
$$;

-- 2) Apto a receber novos plantões e assumir trocas
alter table public.doctors add column available boolean not null default true;

create or replace function public._shifts_check_available() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.doctor_id is not null and (tg_op = 'INSERT' or new.doctor_id is distinct from old.doctor_id)
     and exists (select 1 from doctors where id = new.doctor_id and not available) then
    raise exception 'Este médico está marcado como não apto a receber novos plantões.';
  end if;
  return new;
end $$;
create trigger shifts_check_available before insert or update of doctor_id on public.shifts
  for each row execute function public._shifts_check_available();

-- 3) CRM (número-UF) e telefone (+55 DDD número)
alter table public.doctors add constraint doctors_crm_format check (crm is null or crm ~ '^[0-9]{1,7}-(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$');
alter table public.doctors add constraint doctors_phone_format check (phone is null or phone ~ '^\+55(1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])(9[0-9]{8}|[2-8][0-9]{7})$');

create or replace function public.update_my_profile(p_crm text, p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_doc doctors;
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  if p_crm is null or p_crm !~ '^[0-9]{1,7}-[A-Z]{2}$' then raise exception 'CRM inválido. Informe só os números e a sigla do estado, por exemplo 123456-SP.'; end if;
  if p_phone is null or p_phone !~ '^\+55[0-9]{10,11}$' then raise exception 'Telefone inválido. Informe DDD e número, por exemplo +55 11 91234-5678.'; end if;
  update doctors set crm = p_crm, phone = p_phone where id = v_me returning * into v_doc;
  return row_to_json(v_doc);
exception when check_violation then
  raise exception 'Confira o CRM (número e sigla do estado) e o telefone (DDD válido e número com 8 ou 9 dígitos).';
end $$;

-- 4) Regras de troca: vínculo por UTI e médico apto
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
  if not exists (select 1 from doctors where id = p_to and available) then
    return 'O colega está marcado como não apto a receber novos plantões.';
  end if;
  select * into v_a from shifts where id = p_shift;
  if v_a.doctor_id is distinct from p_from then
    return 'O plantão oferecido não está mais com quem pediu a troca.';
  end if;
  if shift_start(p_shift) <= now() then return 'O plantão oferecido já começou.'; end if;
  if not doctor_works_in(p_to, v_a.unit_id) then
    return 'O colega não trabalha na UTI do plantão oferecido.';
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
    if not exists (select 1 from doctors where id = p_from and available) then
      return 'Quem pediu a troca está marcado como não apto a receber novos plantões.';
    end if;
    if not doctor_works_in(p_from, v_b.unit_id) then
      return 'Quem pediu a troca não trabalha na UTI do plantão de retorno.';
    end if;
    if exists (select 1 from shifts where date = v_b.date and turn = v_b.turn
                 and unit_id <> v_b.unit_id and doctor_id = p_from) then
      return 'Quem pediu a troca já está escalado em outra UTI no turno de retorno.';
    end if;
  end if;
  return null;
end $$;

-- 5) Gestor redireciona o plantão (em vez de só não autorizar), ou designa médico para um anúncio
alter table public.swaps add column redirected_to uuid references public.doctors(id);
create index swaps_redirected_idx on public.swaps(redirected_to);
alter table public.swaps drop constraint swaps_status_check;
alter table public.swaps add constraint swaps_status_check
  check (status in ('aberta','colega','gestor','aprovada','recusada','negada','cancelada','redirecionada'));
alter table public.swaps drop constraint swaps_to_doctor_check;
alter table public.swaps add constraint swaps_to_doctor_check
  check (to_doctor is not null or status in ('aberta','cancelada','redirecionada'));

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
  update shifts set doctor_id = p_doctor where id = v_s.shift_id;
  update swaps set status = 'redirecionada', redirected_to = p_doctor, decided_at = now(), decided_by = my_doctor_id() where id = p_id;
end $$;

revoke execute on function public.update_my_profile(text, text) from public, anon;
revoke execute on function public.manager_redirect_swap(uuid, uuid) from public, anon;
revoke execute on function public.doctor_works_in(uuid, text) from public, anon;
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.manager_redirect_swap(uuid, uuid) to authenticated;
grant execute on function public.doctor_works_in(uuid, text) to authenticated;

-- remove o vínculo antigo por hospital
drop table public.doctor_hospitals;
drop function if exists public.doctor_works_at(uuid, text);

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.doctor_units;
  end if;
end $$;
