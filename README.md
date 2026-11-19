# Opus Scala — app de escala, trocas e presença (antigo Plantão UTI)

PWA estático (HTML + JavaScript puro, sem build) + Supabase (Postgres, login por código no e-mail, RLS, funções RPC, Realtime).
5 UTIs em 3 hospitais, turnos fixos 7h–19h e 19h–7h. A especificação técnica completa está no documento "Plantão UTI — Especificação técnica e guia de implantação".

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Estrutura e todo o CSS (tema claro/escuro, responsivo) |
| `app.js` | Lógica do frontend |
| `config.js` | URL e chave pública (anon) do Supabase — **preencher** |
| `sw.js` | Service worker (rede primeiro, cache de reserva) |
| `manifest.webmanifest`, `icons/` | Instalação na tela inicial (PWA) |
| `vendor/supabase.js` | @supabase/supabase-js v2.45.4 (UMD oficial) |
| `supabase/schema.sql` | Banco completo — versão 2.1 revisada (ver "Mudanças") |

## Implantação (30 a 60 min)

1. **Supabase**: crie o projeto na região *South America (São Paulo)*. No SQL Editor, rode `supabase/schema.sql` inteiro, uma vez. Confira em *Database > Publications* que `supabase_realtime` tem as 7 tabelas.
2. **Primeiro gestor** (e-mail em minúsculas):
   ```sql
   insert into doctors (name, crm, email, is_manager)
   values ('Nome do Gestor', '000000', 'email.do.gestor@exemplo.com', true);
   ```
3. **Auth**: deixe o provedor Email ativo. Em *Email Templates*, inclua `{{ .Token }}` no modelo *Magic Link* (e no *Confirm signup*, se a confirmação estiver ligada):
   ```html
   <h2>Seu código de acesso ao Plantão UTI</h2>
   <p>Digite este código no app: <strong>{{ .Token }}</strong></p>
   <p>Ou toque no link para entrar: <a href="{{ .ConfirmationURL }}">entrar</a></p>
   ```
   Configure **SMTP próprio** antes de abrir para a equipe (o envio padrão do Supabase serve só para testes), com SPF e DKIM. Em *URL Configuration*, preencha *Site URL* e *Redirect URLs* com o endereço final do app.
4. **config.js**: cole a *Project URL* e a chave **anon/publishable** (*Project Settings > API*). Nunca a `service_role`.
5. **Hospedagem**: qualquer hospedagem estática com **HTTPS** (Netlify Drop, Vercel, Cloudflare Pages, GitHub Pages, nginx/IIS). Publique a pasta inteira. Sirva `sw.js` com `Cache-Control: no-cache`.
6. **Primeiro acesso**: o gestor entra, renomeia hospitais/UTIs e grava as coordenadas em *Ajustes*, cadastra a equipe em *Equipe*, monta a escala e divulga o link (iPhone: Safari > Compartilhar > Adicionar à Tela de Início; Android: Chrome > menu > Instalar app).

## Atualizações

- Frontend: altere os arquivos, troque o nome do cache em `sw.js` (`plantao-uti-v1` → `v2`) e publique.
- Banco: só scripts incrementais (`alter table`, `create or replace function`). **Nunca** rode o `schema.sql` de novo num banco em uso.

## Mudanças da versão 2.1 em relação ao schema transcrito na especificação

| # | Tipo | O que mudou |
|---|---|---|
| S1 | **Segurança (crítico)** | `check_in`/`check_out` com `lat`/`lng` nulos davam distância nula e **pulavam a verificação do raio**: qualquer médico podia registrar presença de casa chamando a API. Agora coordenadas nulas, fora da faixa ou (0,0) são recusadas. |
| S2 | Regra | O gestor podia aprovar troca para um médico desativado depois do aceite. `_swap_problem` agora exige os dois médicos ativos. |
| S3 | Concorrência | Dois pedidos simultâneos para o mesmo plantão podiam passar. `request_swap` trava as linhas dos plantões antes de checar. |
| S4 | Integridade | Trigger impede ficar sem nenhum gestor ativo (antes só o app impedia). |
| S5 | Usabilidade | E-mail é normalizado por trigger (antes, maiúscula no cadastro por SQL quebrava o check). |
| S6 | Integridade | `settings.tz` inválido derrubaria todo o cálculo de turnos; agora é validado. |
| S7 | Auditoria | Ajuste manual grava `attendance_log` (quem, quando, antes e depois) e marca `attendance.manual`; distâncias de GPS do horário substituído são limpas. Era o item 4 dos próximos passos. |
| S8 | Segurança | `_swap_problem` e funções internas fora da API. Hospitais e UTIs não podem ser apagados pela API. |
| P1 | Desempenho | Políticas RLS com `(select f())` (avaliadas uma vez por consulta). |
| P2 | Manutenção | `search_path` fixo em todas as funções, `updated_at` automático, índice em `swaps(status)`. |

Nenhuma regra de negócio decidida com o solicitante foi alterada.

## Testes feitos

- **Banco** (PostgreSQL 16 local, `auth.uid()`/`auth.email()` e roles `anon`/`authenticated` simulados): 41 testes — vínculo por e-mail, RLS de leitura e escrita, permuta completa, "A escala mudou desde o pedido", check-in recusado a 979 m e aceito a 15 m, abertura do check-in, check-out, ajuste manual com auditoria, e todas as correções acima.
- **Frontend** (Chrome headless, cliente Supabase falso, GPS simulado): 30 testes — login por código, todas as abas do gestor e do plantonista, escalar, conflito, repetir semana, autorizar troca, CSV (UTF-8 com BOM, `;`), ajuste manual, cadastro, coordenadas pelo GPS, check-in longe/perto, saída antecipada, pedido de permuta, tema escuro, sem erros de JavaScript.
- **Falta**: o teste de ponta a ponta num projeto Supabase real e em celulares reais (roteiro de aceitação da especificação).

## Limitações conhecidas

GPS falsificado por app de terceiros não é detectável no navegador; sem notificações nesta versão (pendências aparecem como contador na aba Trocas); turnos 7–19/19–7 fixos no código; hospitais e UTIs são criados só por SQL.
