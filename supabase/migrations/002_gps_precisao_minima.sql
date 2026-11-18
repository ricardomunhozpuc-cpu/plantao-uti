-- 18/11/2026 — aplicado no projeto Supabase "Plantão UTI".
-- Raio de check-in dos 3 hospitais reduzido para 100 m (dado, feito por UPDATE).
-- Precisão mínima do GPS: check-in/out recusados se a precisão informada pelo
-- celular for pior que settings.max_acc_m (padrão 100 m, faixa 10–500).
alter table public.settings add column max_acc_m int not null default 100 check (max_acc_m between 10 and 500);
-- função _check_accuracy(p_acc) e novas versões de check_in/check_out:
-- ver supabase/schema.sql (as funções chamam perform _check_accuracy(p_acc)
-- logo antes do cálculo de distância).
