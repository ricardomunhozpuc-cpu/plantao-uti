-- =====================================================================
-- Plantão UTI: esquema do banco de dados (Supabase / PostgreSQL)
-- Versão 2.1 (revisada). Rode este arquivo inteiro UMA vez, num projeto
-- Supabase novo, no SQL Editor. Não rode de novo sobre um banco em uso.
--
-- Mudanças em relação à versão transcrita na especificação (v2.0):
--  [S1] check_in/check_out recusam coordenadas nulas ou fora da faixa
--       (antes, lat/lng nulos davam distância nula e o raio era ignorado).
--  [S2] _swap_problem exige que os dois médicos continuem ativos
--       (antes, o gestor podia aprovar troca para médico já desativado).
--  [S3] request_swap trava as linhas dos plantões antes de checar pedidos
--       pendentes (evita dois pedidos simultâneos para o mesmo plantão).
--  [S4] Trigger impede ficar sem nenhum gestor ativo.
--  [S5] E-mail do médico é normalizado (minúsculas, sem espaços) por
--       trigger, em vez de falhar no check.
--  [S6] settings.tz é validado (fuso inválido quebraria todo o cálculo).
--  [S7] Trilha de auditoria: attendance_log registra cada ajuste manual
--       (quem, quando, valores antes e depois); attendance ganha a coluna
--       manual para o relatório distinguir registro por GPS de ajuste.
--  [S8] _swap_problem e funções internas não ficam expostas pela API.
--  [P1] Políticas RLS usam (select f()) para o Postgres avaliar a função
--       uma vez por consulta, não uma vez por linha.
--  [P2] search_path fixo em todas as funções; updated_at automático em
--       shifts; índice em swaps(status).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Parâmetros gerais (linha única)
create table public.settings (
  id            int  primary key default 1 check (id = 1),
  tolerance_min int  not null default 10 check (tolerance_min between 0 and 60),  -- tolerância de atraso
  early_min     int  not null default 60 check (early_min between 0 and 180),     -- check-in liberado antes do início
  tz            text not null default 'America/Sao_Paulo',
  max_acc_m     int  not null default 100 check (max_acc_m between 10 and 500)  -- precisão mínima do GPS
);
insert into public.settings default values;

create table public.hospitals (
  id       text primary key check (id ~ '^[a-z0-9]+$'),
  name     text not null,
  lat      double precision check (lat between -90 and 90),
  lng      double precision check (lng between -180 and 180),
  radius_m int  not null default 100 check (radius_m between 50 and 2000),
  sort     int  not null default 0
);

create table public.units (
  id          text primary key check (id ~ '^[a-z0-9]+$'),
  name        text not null,
  hospital_id text not null references public.hospitals(id),
  sort        int  not null default 0
);

-- Estrutura inicial: 3 hospitais, 5 UTIs (renomeie pelo app em Ajustes)
insert into public.hospitals (id, name, sort) values
  ('h1','Hospital 1',1), ('h2','Hospital 2',2), ('h3','Hospital 3',3);
insert into public.units (id, name, hospital_id, sort) values
  ('u1','UTI 1A','h1',1), ('u2','UTI 1B','h1',2), ('u3','UTI 2A','h2',3),
  ('u4','UTI 2B','h2',4), ('u5','UTI 3','h3',5);

-- Médicos. O vínculo com o login acontece pelo e-mail no primeiro acesso.
create table public.doctors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  crm        text,
  phone      text,
  email      text not null unique check (email = lower(trim(email)) and email like '%_@_%'),
  is_manager boolean not null default false,
  active     boolean not null default true,
  user_id    uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Escala. id = 'AAAA-MM-DD_T_unidade' (T = D diurno 7h-19h, N noturno 19h-7h)
create table public.shifts (
  id         text primary key,
  date       date not null,
  turn       char(1) not null check (turn in ('D','N')),
  unit_id    text not null references public.units(id),
  doctor_id  uuid references public.doctors(id),
  updated_at timestamptz not null default now(),
  check (id = to_char(date,'YYYY-MM-DD') || '_' || turn || '_' || unit_id)
);
create index shifts_date_idx   on public.shifts(date);
create index shifts_doctor_idx on public.shifts(doctor_id);

-- Pedidos de troca
create table public.swaps (
  id              uuid primary key default gen_random_uuid(),
  shift_id        text not null,
  return_shift_id text,                       -- preenchido na permuta
  from_doctor     uuid not null references public.doctors(id),
  to_doctor       uuid not null references public.doctors(id),
  note            text check (char_length(note) <= 280),
  status          text not null default 'colega'
                  check (status in ('colega','gestor','aprovada','recusada','negada','cancelada')),
  created_at      timestamptz not null default now(),
  colleague_at    timestamptz,
  decided_at      timestamptz,
  decided_by      uuid references public.doctors(id)
);
create index swaps_created_idx on public.swaps(created_at desc);
create index swaps_status_idx  on public.swaps(status);
create index swaps_from_idx    on public.swaps(from_doctor);
create index swaps_to_idx      on public.swaps(to_doctor);
create index swaps_decided_idx on public.swaps(decided_by);

-- Presença (check-in / check-out). Guarda só distância e precisão, nunca lat/lng do médico.
create table public.attendance (
  shift_id   text not null,
  doctor_id  uuid not null references public.doctors(id),
  shift_date date not null,
  unit_id    text not null references public.units(id),
  check_in   timestamptz,
  in_dist    int,
  in_acc     int,
  check_out  timestamptz,
  out_dist   int,
  out_acc    int,
  manual     boolean not null default false,   -- [S7] true se o gestor ajustou
  primary key (shift_id, doctor_id)
);
create index attendance_date_idx   on public.attendance(shift_date);
create index attendance_doctor_idx on public.attendance(doctor_id);
create index attendance_unit_idx   on public.attendance(unit_id);
create index units_hospital_idx    on public.units(hospital_id);
create index shifts_unit_idx       on public.shifts(unit_id);

-- [S7] Trilha de auditoria dos ajustes manuais de presença
create table public.attendance_log (
  id         bigint generated always as identity primary key,
  shift_id   text not null,
  doctor_id  uuid not null references public.doctors(id),
  old_in     timestamptz,
  old_out    timestamptz,
  new_in     timestamptz,
  new_out    timestamptz,
  changed_by uuid references public.doctors(id),
  changed_at timestamptz not null default now()
);
create index attendance_log_shift_idx  on public.attendance_log(shift_id);
create index attendance_log_doctor_idx on public.attendance_log(doctor_id);
create index attendance_log_by_idx     on public.attendance_log(changed_by);

-- ---------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------

create or replace function public.my_doctor_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from doctors where user_id = auth.uid() and active
$$;

create or replace function public.i_am_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_manager from doctors where user_id = auth.uid() and active), false)
$$;

create or replace function public.shift_start(p_shift text) returns timestamptz
language sql stable set search_path = public as $$
  select (split_part(p_shift,'_',1)::date
          + case split_part(p_shift,'_',2) when 'D' then time '07:00' else time '19:00' end)
         at time zone (select tz from settings where id = 1)
$$;

create or replace function public.dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable set search_path = public as $$
  select 2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create or replace function public.fmt_dist(d float8) returns text
language sql immutable set search_path = public as $$
  select case when d >= 1000 then replace(to_char(d / 1000.0, 'FM9990.0'), '.', ',') || ' km'
              else round(d)::text || ' m' end
$$;

-- [S1] Valida coordenadas recebidas do celular
create or replace function public._check_coords(p_lat float8, p_lng float8) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or (p_lat = 0 and p_lng = 0) then
    raise exception 'Localização inválida. Tente de novo com o GPS ligado.';
  end if;
end $$;

-- Precisão mínima do GPS (settings.max_acc_m)
create or replace function public._check_accuracy(p_acc float8) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_max int := (select max_acc_m from settings where id = 1);
begin
  if p_acc is null or p_acc <= 0 then
    raise exception 'Não foi possível medir a precisão do GPS. Ative a localização precisa e tente de novo.';
  end if;
  if p_acc > v_max then
    raise exception 'Sinal de GPS fraco (± % m; o limite é % m). Ative a localização precisa, vá para perto de uma janela e tente de novo.', round(p_acc), v_max;
  end if;
end $$;

-- Vincula a conta logada ao cadastro de médico com o mesmo e-mail.
create or replace function public.link_me() returns json
language plpgsql security definer set search_path = public as $$
declare v_doc doctors;
begin
  if auth.uid() is null then return null; end if;
  select * into v_doc from doctors where user_id = auth.uid();
  if not found then
    update doctors set user_id = auth.uid()
     where email = lower(trim(auth.email())) and user_id is null
    returning * into v_doc;
  end if;
  if v_doc.id is null then return null; end if;
  return row_to_json(v_doc);
end $$;

-- Verifica se uma troca ainda pode ser feita. Devolve o problema ou null.
create or replace function public._swap_problem(p_shift text, p_return text, p_from uuid, p_to uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_a shifts; v_b shifts;
begin
  -- [S2] os dois precisam continuar ativos
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
    if exists (select 1 from shifts where date = v_b.date and turn = v_b.turn
                 and unit_id <> v_b.unit_id and doctor_id = p_from) then
      return 'Quem pediu a troca já está escalado em outra UTI no turno de retorno.';
    end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Triggers de integridade
-- ---------------------------------------------------------------------

-- [S5] normaliza e-mail
create or replace function public._doctors_normalize() returns trigger
language plpgsql set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  new.name  := trim(new.name);
  return new;
end $$;
create trigger doctors_normalize before insert or update on public.doctors
  for each row execute function public._doctors_normalize();

-- [S4] sempre pelo menos um gestor ativo
create or replace function public._keep_one_manager() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from doctors where is_manager and active) then
    raise exception 'É preciso manter pelo menos um gestor ativo.';
  end if;
  return null;
end $$;
create constraint trigger doctors_keep_manager after update or delete on public.doctors
  deferrable initially deferred
  for each row execute function public._keep_one_manager();

-- [S6] fuso válido
create or replace function public._settings_check_tz() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.tz) then
    raise exception 'Fuso horário inválido: %', new.tz;
  end if;
  return new;
end $$;
create trigger settings_check_tz before insert or update on public.settings
  for each row execute function public._settings_check_tz();

-- [P2] updated_at automático na escala
create or replace function public._touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
create trigger shifts_touch before update on public.shifts
  for each row execute function public._touch_updated_at();

-- ---------------------------------------------------------------------
-- Ações do plantonista e do gestor (as regras ficam no servidor)
-- ---------------------------------------------------------------------

create or replace function public.request_swap(p_shift text, p_to uuid, p_return text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_ret text := nullif(trim(coalesce(p_return,'')), ''); v_prob text; v_id uuid;
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  if p_to = v_me then raise exception 'Escolha outro colega.'; end if;
  if not exists (select 1 from doctors where id = p_to and active and user_id is not null) then
    raise exception 'O colega precisa ter entrado no app ao menos uma vez.';
  end if;
  -- [S3] serializa pedidos concorrentes sobre os mesmos plantões
  perform 1 from shifts where id in (p_shift, coalesce(v_ret,'-')) order by id for update;
  if exists (select 1 from swaps where status in ('colega','gestor')
               and (shift_id in (p_shift, coalesce(v_ret,'-')) or return_shift_id in (p_shift, coalesce(v_ret,'-')))) then
    raise exception 'Já existe uma troca em andamento para um desses plantões.';
  end if;
  v_prob := _swap_problem(p_shift, v_ret, v_me, p_to);
  if v_prob is not null then raise exception '%', v_prob; end if;
  insert into swaps (shift_id, return_shift_id, from_doctor, to_doctor, note)
  values (p_shift, v_ret, v_me, p_to, nullif(left(trim(coalesce(p_note,'')), 280), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.respond_swap(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_s swaps; v_prob text;
begin
  select * into v_s from swaps where id = p_id for update;
  if not found or v_me is null or v_s.to_doctor is distinct from v_me then raise exception 'Pedido não encontrado.'; end if;
  if v_s.status <> 'colega' then raise exception 'Este pedido já foi respondido.'; end if;
  if p_accept then
    v_prob := _swap_problem(v_s.shift_id, v_s.return_shift_id, v_s.from_doctor, v_s.to_doctor);
    if v_prob is not null then raise exception '%', v_prob; end if;
    update swaps set status = 'gestor', colleague_at = now() where id = p_id;
  else
    update swaps set status = 'recusada', colleague_at = now() where id = p_id;
  end if;
end $$;

create or replace function public.cancel_swap(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_s swaps;
begin
  select * into v_s from swaps where id = p_id for update;
  if not found or v_me is null or v_s.from_doctor is distinct from v_me then raise exception 'Pedido não encontrado.'; end if;
  if v_s.status not in ('colega','gestor') then raise exception 'Este pedido já foi concluído.'; end if;
  update swaps set status = 'cancelada' where id = p_id;
end $$;

-- Autorização do gestor: atualiza a escala e o pedido na mesma transação.
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
    update shifts set doctor_id = v_s.to_doctor where id = v_s.shift_id;
    if v_s.return_shift_id is not null then
      update shifts set doctor_id = v_s.from_doctor where id = v_s.return_shift_id;
    end if;
    update swaps set status = 'aprovada', decided_at = now(), decided_by = my_doctor_id() where id = p_id;
  else
    update swaps set status = 'negada', decided_at = now(), decided_by = my_doctor_id() where id = p_id;
  end if;
end $$;

-- Check-in: confere escala, horário e distância até o hospital.
create or replace function public.check_in(p_shift text, p_lat float8, p_lng float8, p_acc float8)
returns json language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_sh shifts; v_h hospitals; v_cfg settings; v_st timestamptz; v_d float8; v_now timestamptz := now();
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  perform _check_coords(p_lat, p_lng);   -- [S1]
  select * into v_sh from shifts where id = p_shift;
  if not found or v_sh.doctor_id is distinct from v_me then raise exception 'Este plantão não está na sua escala.'; end if;
  select * into v_cfg from settings where id = 1;
  v_st := shift_start(p_shift);
  if v_now < v_st - make_interval(mins => v_cfg.early_min) then
    raise exception 'O check-in deste plantão abre às %.',
      to_char((v_st - make_interval(mins => v_cfg.early_min)) at time zone v_cfg.tz, 'HH24:MI');
  end if;
  if v_now >= v_st + interval '12 hours' then raise exception 'Este plantão já terminou.'; end if;
  if exists (select 1 from attendance where shift_id = p_shift and doctor_id = v_me and check_in is not null) then
    raise exception 'O check-in deste plantão já foi registrado.';
  end if;
  select h.* into v_h from hospitals h join units u on u.hospital_id = h.id where u.id = v_sh.unit_id;
  if v_h.lat is null or v_h.lng is null then raise exception 'O gestor ainda não cadastrou a localização do %.', v_h.name; end if;
  perform _check_accuracy(p_acc);
  v_d := dist_m(p_lat, p_lng, v_h.lat, v_h.lng);
  if v_d > v_h.radius_m then
    raise exception 'Você está a % do %. O registro é liberado a até % m.', fmt_dist(v_d), v_h.name, v_h.radius_m;
  end if;
  insert into attendance (shift_id, doctor_id, shift_date, unit_id, check_in, in_dist, in_acc)
  values (p_shift, v_me, v_sh.date, v_sh.unit_id, v_now, round(v_d), round(p_acc))
  on conflict (shift_id, doctor_id) do update
    set check_in = excluded.check_in, in_dist = excluded.in_dist, in_acc = excluded.in_acc;
  return json_build_object('at', v_now, 'dist', round(v_d));
end $$;

create or replace function public.check_out(p_shift text, p_lat float8, p_lng float8, p_acc float8)
returns json language plpgsql security definer set search_path = public as $$
declare v_me uuid := my_doctor_id(); v_a attendance; v_h hospitals; v_d float8; v_now timestamptz := now();
begin
  if v_me is null then raise exception 'Seu cadastro não está vinculado.'; end if;
  perform _check_coords(p_lat, p_lng);   -- [S1]
  select * into v_a from attendance where shift_id = p_shift and doctor_id = v_me for update;
  if not found or v_a.check_in is null then raise exception 'Não há check-in registrado para este plantão.'; end if;
  if v_a.check_out is not null then raise exception 'O check-out deste plantão já foi registrado.'; end if;
  if v_now > shift_start(p_shift) + interval '18 hours' then
    raise exception 'O prazo para o check-out terminou. Peça ao gestor para registrar a saída.';
  end if;
  select h.* into v_h from hospitals h join units u on u.hospital_id = h.id where u.id = v_a.unit_id;
  if v_h.lat is null or v_h.lng is null then raise exception 'O gestor ainda não cadastrou a localização do %.', v_h.name; end if;
  perform _check_accuracy(p_acc);
  v_d := dist_m(p_lat, p_lng, v_h.lat, v_h.lng);
  if v_d > v_h.radius_m then
    raise exception 'Você está a % do %. O registro é liberado a até % m.', fmt_dist(v_d), v_h.name, v_h.radius_m;
  end if;
  update attendance set check_out = v_now, out_dist = round(v_d), out_acc = round(p_acc)
   where shift_id = p_shift and doctor_id = v_me;
  return json_build_object('at', v_now, 'dist', round(v_d));
end $$;

-- Ajuste manual de presença pelo gestor (esquecimento, falha de GPS etc.)
-- [S7] grava trilha em attendance_log e marca a linha como manual.
create or replace function public.manager_set_attendance(p_shift text, p_doctor uuid, p_in timestamptz, p_out timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_sh shifts; v_old attendance;
begin
  if not i_am_manager() then raise exception 'Apenas o gestor ajusta presença.'; end if;
  select * into v_sh from shifts where id = p_shift;
  if not found then raise exception 'Plantão não encontrado.'; end if;
  if not exists (select 1 from doctors where id = p_doctor) then raise exception 'Médico não encontrado.'; end if;
  if p_in is null and p_out is not null then raise exception 'Informe a entrada para registrar a saída.'; end if;
  if p_in is not null and p_out is not null and p_out <= p_in then raise exception 'A saída precisa ser depois da entrada.'; end if;
  select * into v_old from attendance where shift_id = p_shift and doctor_id = p_doctor for update;
  insert into attendance (shift_id, doctor_id, shift_date, unit_id, check_in, check_out, manual)
  values (p_shift, p_doctor, v_sh.date, v_sh.unit_id, p_in, p_out, true)
  on conflict (shift_id, doctor_id) do update
    set check_in  = excluded.check_in,
        check_out = excluded.check_out,
        in_dist   = case when attendance.check_in  is not distinct from excluded.check_in  then attendance.in_dist  end,
        in_acc    = case when attendance.check_in  is not distinct from excluded.check_in  then attendance.in_acc   end,
        out_dist  = case when attendance.check_out is not distinct from excluded.check_out then attendance.out_dist end,
        out_acc   = case when attendance.check_out is not distinct from excluded.check_out then attendance.out_acc  end,
        manual    = true;
  insert into attendance_log (shift_id, doctor_id, old_in, old_out, new_in, new_out, changed_by)
  values (p_shift, p_doctor, v_old.check_in, v_old.check_out, p_in, p_out, my_doctor_id());
end $$;

-- ---------------------------------------------------------------------
-- Segurança por linha (RLS)
-- ---------------------------------------------------------------------
alter table public.settings       enable row level security;
alter table public.hospitals      enable row level security;
alter table public.units          enable row level security;
alter table public.doctors        enable row level security;
alter table public.shifts         enable row level security;
alter table public.swaps          enable row level security;
alter table public.attendance     enable row level security;
alter table public.attendance_log enable row level security;

-- Leitura: qualquer médico ativo e vinculado  [P1: (select f()) = avaliado uma vez]
create policy team_read on public.settings  for select to authenticated using ((select my_doctor_id()) is not null);
create policy team_read on public.hospitals for select to authenticated using ((select my_doctor_id()) is not null);
create policy team_read on public.units     for select to authenticated using ((select my_doctor_id()) is not null);
create policy team_read on public.shifts    for select to authenticated using ((select my_doctor_id()) is not null);
create policy team_read on public.swaps     for select to authenticated using ((select my_doctor_id()) is not null);
-- Presença: cada um vê a própria; o gestor vê todas
create policy own_or_manager on public.attendance for select to authenticated
  using (doctor_id = (select my_doctor_id()) or (select i_am_manager()));
create policy manager_read on public.attendance_log for select to authenticated
  using ((select i_am_manager()));

-- Escrita direta: só o gestor (trocas e presença passam pelas funções acima)
create policy manager_update on public.settings  for update to authenticated using ((select i_am_manager())) with check ((select i_am_manager()));
create policy manager_insert on public.hospitals for insert to authenticated with check ((select i_am_manager()));
create policy manager_update on public.hospitals for update to authenticated using ((select i_am_manager())) with check ((select i_am_manager()));
create policy manager_update on public.units     for update to authenticated using ((select i_am_manager())) with check ((select i_am_manager()));
create policy manager_insert on public.units     for insert to authenticated with check ((select i_am_manager()));
-- doctors e shifts: uma política por ação (evita políticas permissivas sobrepostas no select)
create policy team_read      on public.doctors for select to authenticated using ((select my_doctor_id()) is not null);
create policy manager_insert on public.doctors for insert to authenticated with check ((select i_am_manager()));
create policy manager_update on public.doctors for update to authenticated using ((select i_am_manager())) with check ((select i_am_manager()));
create policy manager_delete on public.doctors for delete to authenticated using ((select i_am_manager()));
create policy manager_insert on public.shifts  for insert to authenticated with check ((select i_am_manager()));
create policy manager_update on public.shifts  for update to authenticated using ((select i_am_manager())) with check ((select i_am_manager()));
create policy manager_delete on public.shifts  for delete to authenticated using ((select i_am_manager()));

-- Funções: só usuários logados executam; funções internas ficam fora da API  [S8]
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on function public._swap_problem(text, text, uuid, uuid) from authenticated;
revoke execute on function public._check_coords(float8, float8)       from authenticated;
revoke execute on function public._check_accuracy(float8)              from authenticated;
revoke execute on function public._doctors_normalize()                 from authenticated;
revoke execute on function public._keep_one_manager()                  from authenticated;
revoke execute on function public._settings_check_tz()                 from authenticated;
revoke execute on function public._touch_updated_at()                  from authenticated;

-- ---------------------------------------------------------------------
-- Tempo real (atualiza as telas abertas automaticamente)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.settings, public.hospitals, public.units, public.doctors,
      public.shifts, public.swaps, public.attendance;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Primeiro gestor: troque nome, CRM e e-mail e rode separadamente.
-- insert into public.doctors (name, crm, email, is_manager)
-- values ('Nome do Gestor', '000000', 'email.do.gestor@exemplo.com', true);
-- ---------------------------------------------------------------------
