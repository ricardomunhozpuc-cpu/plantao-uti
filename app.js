/* =====================================================================
   Plantão UTI — frontend (JavaScript puro, sem framework, sem build)
   Blocos: helpers · supabase · state · data loading · realtime ·
           auth flow · views · actions · boot
   Toda regra que importa é validada no banco (RLS + funções RPC).
   As validações daqui existem só para dar respostas rápidas na tela.
   ===================================================================== */
(function () {
  'use strict';

  /* ================================ helpers ================================ */
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad2 = (n) => String(n).padStart(2, '0');
  const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MON = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const HOUR = 3600000, MIN = 60000, DAY = 86400000;

  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const addDaysS = (s, n) => ymd(addDays(parseYmd(s), n));
  const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const w = (x.getDay() + 6) % 7; return addDays(x, -w); };
  const sid = (date, turn, unit) => (typeof date === 'string' ? date : ymd(date)) + '_' + turn + '_' + unit;
  const parseSid = (id) => { const p = String(id).split('_'); return { date: p[0], turn: p[1], unit: p[2] }; };
  const slotStart = (date, turn) => { const d = parseYmd(date); d.setHours(turn === 'D' ? 7 : 19, 0, 0, 0); return d; };
  const shiftStart = (id) => { const p = parseSid(id); return slotStart(p.date, p.turn); };
  const shiftEnd = (id) => new Date(shiftStart(id).getTime() + 12 * HOUR);
  // Qual turno está em andamento num instante (o noturno pertence à data em que começa)
  function slotAt(now) {
    const h = now.getHours();
    if (h < 7) return { date: ymd(addDays(now, -1)), turn: 'N' };
    if (h < 19) return { date: ymd(now), turn: 'D' };
    return { date: ymd(now), turn: 'N' };
  }
  const slotMove = (s, dir) => (dir > 0
    ? (s.turn === 'D' ? { date: s.date, turn: 'N' } : { date: addDaysS(s.date, 1), turn: 'D' })
    : (s.turn === 'N' ? { date: s.date, turn: 'D' } : { date: addDaysS(s.date, -1), turn: 'N' }));

  const fmtHM = (d) => { d = new Date(d); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const fmtDM = (d) => { d = typeof d === 'string' && d.length === 10 ? parseYmd(d) : new Date(d); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); };
  const fmtDMY = (d) => { d = typeof d === 'string' && d.length === 10 ? parseYmd(d) : new Date(d); return fmtDM(d) + '/' + d.getFullYear(); };
  const fmtDT = (d) => fmtDM(d) + ' ' + fmtHM(d);
  const fmtDay = (s) => { const d = parseYmd(s); return DOW[d.getDay()] + ' ' + fmtDM(d); };
  const turnName = (t) => (t === 'D' ? 'Diurno' : 'Noturno');
  const turnHours = (t) => (t === 'D' ? '7h–19h' : '19h–7h');
  const fmtDur = (ms) => { const m = Math.max(0, Math.round(ms / MIN)); return Math.floor(m / 60) + 'h' + pad2(m % 60); };
  const hoursDec = (ms) => (ms / HOUR).toFixed(2).replace('.', ',');
  const fmtDist = (m) => (m == null ? '' : m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m');
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return ymd(d) + 'T' + fmtHM(d); };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
  const shortName = (n) => { const p = String(n || '').replace(/^(dr|dra)\.?\s+/i, '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1] : p[0] || ''; };
  const weekLabel = (ws) => { const we = addDays(ws, 6); return ws.getMonth() === we.getMonth() ? ws.getDate() + '–' + we.getDate() + ' ' + MON[ws.getMonth()] + ' ' + we.getFullYear() : ws.getDate() + ' ' + MON[ws.getMonth()] + ' – ' + we.getDate() + ' ' + MON[we.getMonth()] + ' ' + we.getFullYear(); };

  const ICON = {
    agora: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    escala: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    trocas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    presenca: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    equipe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
    meu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>'
  };

  /* ================================ supabase =============================== */
  const CFG = window.PLANTAO_CONFIG || {};
  let sb = null;

  function errText(e) {
    if (!e) return 'Erro desconhecido.';
    const m = String(e.message || e.error_description || e.msg || e);
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    if (/rate limit|too many|over_email_send_rate/i.test(m)) return 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.';
    if (/Token has expired|otp.*(expired|invalid)|invalid.*(token|otp)/i.test(m)) return 'Código inválido ou expirado. Confira os dígitos ou peça um novo código.';
    if (/Auth session missing|session_not_found|refresh_token_not_found|Invalid Refresh Token/i.test(m)) return 'Sua sessão expirou. Toque em "Entrar de novo", receba o código por e-mail e crie a senha logo em seguida.';
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos. No primeiro acesso, ou se esqueceu a senha, use "Receber código por e-mail".';
    if (/Password should be at least|weak.?password/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (/should be different|same_password/i.test(m)) return 'A nova senha precisa ser diferente da atual.';
    if (/Email not confirmed/i.test(m)) return 'E-mail ainda não confirmado. Use "Receber código por e-mail".';
    if (/Signups not allowed/i.test(m)) return 'O cadastro de novos acessos está desativado no servidor. Fale com a TI.';
    if (/JWT expired|invalid jwt/i.test(m)) return 'Sua sessão expirou. Saia e entre de novo.';
    if (/doctors_email_key|duplicate key.*email/i.test(m)) return 'Já existe um médico com este e-mail.';
    if (/doctors_email_check/i.test(m)) return 'E-mail inválido.';
    if (/doctors_name_check/i.test(m)) return 'Informe o nome.';
    if (/row-level security|permission denied/i.test(m)) return 'Você não tem permissão para esta ação.';
    if (/violates foreign key/i.test(m)) return 'Este registro está em uso e não pode ser removido.';
    return m;
  }

  async function fetchAll(make) {
    let all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return all;
  }

  /* ================================= state ================================= */
  const S = {
    session: null, me: null, role: 'plantonista', tab: null, started: false,
    settings: { tolerance_min: 10, early_min: 60, tz: 'America/Sao_Paulo' },
    hospitals: [], units: [], doctors: [], links: new Map(), pushSt: null,
    shifts: new Map(), att: new Map(), swaps: [],
    range: null, week: startOfWeek(new Date()),
    pres: null, login: { step: 'email', email: '', resendAt: 0 },
    modal: null, channel: null, dirty: false, tick: null
  };
  const docById = (id) => S.doctors.find((d) => d.id === id);
  const unitById = (id) => S.units.find((u) => u.id === id);
  const hospById = (id) => S.hospitals.find((h) => h.id === id);
  const hospOfUnit = (uid) => { const u = unitById(uid); return u ? hospById(u.hospital_id) : null; };
  const isMgr = () => !!(S.me && S.me.is_manager);
  // Hospitais em que o médico trabalha (sem vínculo = todos)
  const docHosps = (id) => S.links.get(id) || null;
  const worksAt = (docId, hospId) => { const s = docHosps(docId); return !s || s.has(hospId); };
  const unitHosp = (uid) => (unitById(uid) || {}).hospital_id;
  const visibleHospitals = () => (S.role === 'gestor' ? S.hospitals : S.hospitals.filter((h) => worksAt(S.me.id, h.id)));
  const filterKey = () => 'plantao-filtro-' + S.me.id + '-' + S.role;
  function selectedHospitals() {
    const vis = visibleHospitals(); let sel = null;
    try { sel = JSON.parse(localStorage.getItem(filterKey()) || 'null'); } catch (e) { /* */ }
    const out = Array.isArray(sel) ? vis.filter((h) => sel.includes(h.id)) : vis;
    return out.length ? out : vis;
  }
  function setFilter(ids) { try { localStorage.setItem(filterKey(), JSON.stringify(ids)); } catch (e) { /* */ } }
  const hasPw = () => !!(S.session && S.session.user && S.session.user.user_metadata && S.session.user.user_metadata.has_password);
  // Na escala, médico desativado (ou apagado) aparece como "Médico removido"
  const docScaleName = (id) => { const d = docById(id); return !d || !d.active ? 'Médico removido' : d.name; };
  const docHistName = (id) => { const d = docById(id); return !d ? 'Médico removido' : d.name + (d.active ? '' : ' (inativo)'); };
  const unitName = (uid) => (unitById(uid) || {}).name || uid;
  const unitFull = (uid) => { const h = hospOfUnit(uid); return unitName(uid) + (h ? ' · ' + h.name : ''); };
  const shiftDesc = (id) => { const p = parseSid(id); return fmtDay(p.date) + ' · ' + turnName(p.turn) + ' ' + turnHours(p.turn) + ' · ' + unitFull(p.unit); };
  const attOf = (shiftId, docId) => S.att.get(shiftId + '|' + docId);
  const docOf = (shiftId) => { const s = S.shifts.get(shiftId); return s ? s.doctor_id : null; };
  const pendingSwapFor = (id) => S.swaps.find((w) => (w.status === 'colega' || w.status === 'gestor') && (w.shift_id === id || w.return_shift_id === id));
  // Em que UTI um médico está num turno (exceto a UTI informada)
  function whereElse(docId, date, turn, exceptUnit) {
    for (const u of S.units) {
      if (u.id === exceptUnit) continue;
      if (docOf(sid(date, turn, u.id)) === docId) return u.id;
    }
    return null;
  }
  const myShifts = () => [...S.shifts.values()].filter((s) => s.doctor_id === S.me.id).sort((a, b) => shiftStart(a.id) - shiftStart(b.id));

  /* Situação de presença de um plantão em um instante */
  function attStatus(shiftId, docId, now) {
    now = now || new Date();
    const tol = S.settings.tolerance_min * MIN, early = S.settings.early_min * MIN;
    const st = shiftStart(shiftId), en = shiftEnd(shiftId);
    if (!docId) return { code: 'vazio', label: 'Sem escala', tone: 'muted' };
    const a = attOf(shiftId, docId);
    const r = { a, lateMin: 0, earlyOut: false, manual: !!(a && a.manual) };
    if (a && a.check_in) {
      const ci = new Date(a.check_in);
      if (ci - st > tol) r.lateMin = Math.round((ci - st) / MIN);
      if (a.check_out) {
        const co = new Date(a.check_out);
        r.earlyOut = co < en - tol;
        return Object.assign(r, { code: 'saiu', label: 'Já saiu às ' + fmtHM(co), tone: r.earlyOut ? 'warn' : 'muted' });
      }
      if (now > en) return Object.assign(r, { code: 'semout', label: 'Sem check-out', tone: 'warn' });
      return Object.assign(r, r.lateMin
        ? { code: 'presente', label: 'Presente · atraso ' + r.lateMin + ' min', tone: 'warn' }
        : { code: 'presente', label: 'Presente desde ' + fmtHM(ci), tone: 'ok' });
    }
    if (now < st - early) return Object.assign(r, { code: 'futuro', label: 'Agendado', tone: 'muted' });
    if (now < st + tol) return Object.assign(r, { code: 'aguardando', label: 'Aguardando check-in', tone: 'info' });
    if (now > en) return Object.assign(r, { code: 'semin', label: 'Sem check-in', tone: 'bad' });
    return Object.assign(r, { code: 'semin', label: 'Sem check-in', tone: 'bad' });
  }

  /* Classificação de pontualidade para a aba Presença e o CSV */
  function classify(shiftId, docId, now) {
    now = now || new Date();
    const tol = S.settings.tolerance_min * MIN;
    const st = shiftStart(shiftId), en = shiftEnd(shiftId);
    const a = attOf(shiftId, docId);
    const tags = []; let lateMin = 0, hoursMs = 0;
    if (!a || !a.check_in) {
      if (now < st + tol) tags.push(['Aguardando', 'info']);
      else tags.push(['Sem check-in', 'bad']);
    } else {
      const ci = new Date(a.check_in);
      if (ci - st > tol) { lateMin = Math.round((ci - st) / MIN); tags.push(['Atraso ' + lateMin + ' min', 'warn']); }
      else tags.push(['Pontual', 'ok']);
      if (a.check_out) {
        const co = new Date(a.check_out); hoursMs = co - ci;
        if (co < en - tol) tags.push(['Saída antecipada', 'warn']);
      } else if (now > en) tags.push(['Sem check-out', 'bad']);
      else tags.push(['Em andamento', 'info']);
    }
    if (a && a.manual) tags.push(['Ajuste manual', 'brand']);
    return { a, tags, lateMin, hoursMs };
  }

  /* ============================== data loading ============================= */
  async function loadStatic() {
    const [st, hs, us, ds, lk] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('hospitals').select('*').order('sort').order('id'),
      sb.from('units').select('*').order('sort').order('id'),
      fetchAll(() => sb.from('doctors').select('*').order('name')),
      fetchAll(() => sb.from('doctor_hospitals').select('*').order('doctor_id'))
    ]);
    if (st.error) throw st.error; if (hs.error) throw hs.error; if (us.error) throw us.error;
    if (st.data) S.settings = st.data;
    S.hospitals = hs.data || []; S.units = us.data || []; S.doctors = ds;
    S.links = new Map(); lk.forEach((r) => { if (!S.links.has(r.doctor_id)) S.links.set(r.doctor_id, new Set()); S.links.get(r.doctor_id).add(r.hospital_id); });
    const me = docById(S.me.id); if (me) S.me = me;
  }
  async function loadShifts() {
    if (!S.range) return;
    const rows = await fetchAll(() => sb.from('shifts').select('*').gte('date', S.range.from).lte('date', S.range.to).order('id'));
    S.shifts = new Map(rows.filter((r) => r.doctor_id).map((r) => [r.id, r]));
  }
  async function loadAtt() {
    if (!S.range) return;
    const rows = await fetchAll(() => sb.from('attendance').select('*').gte('shift_date', S.range.from).lte('shift_date', S.range.to).order('shift_id'));
    S.att = new Map(rows.map((r) => [r.shift_id + '|' + r.doctor_id, r]));
  }
  async function loadSwaps() {
    const { data, error } = await sb.from('swaps').select('*').order('created_at', { ascending: false }).limit(400);
    if (error) throw error;
    S.swaps = data || [];
  }
  // Amplia o intervalo de datas carregado, se preciso, e recarrega escala e presença
  async function ensureRange(from, to) {
    if (S.range && from >= S.range.from && to <= S.range.to) return false;
    S.range = S.range ? { from: from < S.range.from ? from : S.range.from, to: to > S.range.to ? to : S.range.to } : { from, to };
    await Promise.all([loadShifts(), loadAtt()]);
    return true;
  }
  async function reloadAll() {
    await Promise.all([loadStatic(), loadShifts(), loadAtt(), loadSwaps()]);
  }

  /* ================================ realtime =============================== */
  const rtPending = new Set(); let rtTimer = null;
  function subscribe() {
    if (S.channel) sb.removeChannel(S.channel);
    S.channel = sb.channel('plantao-db')
      .on('postgres_changes', { event: '*', schema: 'public' }, (p) => queueReload(p.table))
      .subscribe();
  }
  function queueReload(table) {
    rtPending.add(table);
    clearTimeout(rtTimer);
    rtTimer = setTimeout(async () => {
      const t = new Set(rtPending); rtPending.clear();
      try {
        const jobs = [];
        if (t.has('settings') || t.has('hospitals') || t.has('units') || t.has('doctors') || t.has('doctor_hospitals')) jobs.push(loadStatic());
        if (t.has('shifts') || t.has('doctor_hospitals')) jobs.push(loadShifts());
        if (t.has('attendance')) jobs.push(loadAtt());
        if (t.has('swaps')) jobs.push(loadSwaps());
        await Promise.all(jobs);
        if (S.me && !S.me.active) { showBlocked('inactive'); return; }
        render();
      } catch (e) { console.warn('realtime reload', e); }
    }, 350);
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S.started) return;
    try { await Promise.all([loadShifts(), loadAtt(), loadSwaps()]); render(); } catch (e) { console.warn(e); }
  });

  /* =============================== auth flow =============================== */
  async function boot() {
    if (!CFG.url || !CFG.anonKey || /SEU-PROJETO|COLE_AQUI/.test(CFG.url + CFG.anonKey)) { showConfigError(); return; }
    if (!window.supabase || !window.supabase.createClient) { showFatal('Não foi possível carregar a biblioteca do Supabase (vendor/supabase.js).'); return; }
    sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'plantao-uti-auth' }
    });
    sb.auth.onAuthStateChange((ev, session) => {
      S.session = session;
      if (ev === 'SIGNED_OUT' && S.started) { setTimeout(resetToLogin, 0); return; }
      // não chamar o supabase de dentro do callback (evita travamento); adia
      if (ev === 'SIGNED_OUT') setTimeout(resetToLogin, 0);
      else if (session && !S.started && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION')) setTimeout(startApp, 0);
    });
    const { data } = await sb.auth.getSession();
    if (data && data.session) { S.session = data.session; startApp(); }
    else {
      const h = new URLSearchParams(location.hash.replace(/^#/, '') || location.search.replace(/^\?/, ''));
      const err = h.get('error_description');
      if (err) history.replaceState(null, '', location.pathname);
      showLogin(err ? 'O link de acesso expirou ou já foi usado. Peça um novo código.' : '');
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
    }
  }

  let starting = false;
  async function startApp() {
    if (S.started || starting) return; starting = true;
    setApp('<div class="center"><div class="spinner" aria-label="Carregando"></div></div>');
    try {
      const { data, error } = await sb.rpc('link_me');
      if (error) throw error;
      if (!data) { showBlocked('unknown'); return; }
      S.me = data;
      if (!data.active) { showBlocked('inactive'); return; }
      S.role = data.is_manager ? 'gestor' : 'plantonista';
      S.tab = S.role === 'gestor' ? 'agora' : 'meu';
      const qtab = new URLSearchParams(location.search).get('tab');
      if (qtab) {
        if (TABS[S.role].some((t) => t[0] === qtab)) S.tab = qtab;
        else if (S.role === 'gestor' && TABS.plantonista.some((t) => t[0] === qtab)) { S.role = 'plantonista'; S.tab = qtab; }
        history.replaceState(null, '', location.pathname);
      }
      const today = new Date();
      await Promise.all([loadStatic(), ensureRange(ymd(addDays(today, -35)), ymd(addDays(today, 70))), loadSwaps()]);
      S.pres = { from: ymd(addDays(today, -30)), to: ymd(today), doctor: '' };
      S.started = true;
      subscribe();
      clearInterval(S.tick);
      S.tick = setInterval(() => { if (S.tab === 'agora' || S.tab === 'meu') render(); }, 30000);
      render(true);
      refreshPushState(true);
      if (!hasPw() && !sessionStorage.getItem('plantao-pw-later')) setTimeout(() => { if (!S.modal) openPwModal(true); }, 700);
    } catch (e) {
      showFatal(errText(e), true);
    } finally { starting = false; }
  }

  function resetToLogin() {
    if (S.channel) { try { sb.removeChannel(S.channel); } catch (e) { /* */ } S.channel = null; }
    clearInterval(S.tick);
    Object.assign(S, { session: null, me: null, started: false, shifts: new Map(), att: new Map(), swaps: [], doctors: [], range: null });
    S.login = { step: 'email', email: '', resendAt: 0 };
    closeModal();
    showLogin();
  }
  async function logout() {
    try { await disablePush(true); } catch (e) { /* */ }
    try { await sb.auth.signOut(); } catch (e) { /* */ }
    resetToLogin();
  }

  /* ================================= views ================================= */
  const setApp = (html) => { $('#app').innerHTML = html; };

  function showConfigError() {
    setApp('<div class="center"><div class="card login stack"><h2>Configuração pendente</h2><p>Preencha a URL e a chave pública do Supabase no arquivo <code>config.js</code> e publique de novo.</p></div></div>');
  }
  function showFatal(msg, canRetry) {
    setApp('<div class="center"><div class="card login stack"><h2>Não foi possível abrir o app</h2><p>' + esc(msg) + '</p><div class="row">' +
      (canRetry ? '<button class="btn primary" data-act="reload">Tentar de novo</button>' : '') +
      '<button class="btn" data-act="logout">Sair</button></div></div></div>');
  }
  function showBlocked(kind) {
    const email = S.session && S.session.user ? S.session.user.email : '';
    const t = kind === 'inactive'
      ? ['Cadastro inativo', 'Seu cadastro está inativo. Se isso for um engano, fale com o gestor da escala.']
      : ['E-mail não cadastrado', 'O e-mail <b>' + esc(email) + '</b> não está cadastrado na equipe. Peça ao gestor para cadastrá-lo exatamente como você digitou, ou entre com outro e-mail.'];
    S.started = false;
    setApp('<div class="center"><div class="card login stack"><div class="logo"><img src="icons/icon-192.png" alt=""><h2>' + t[0] + '</h2></div><p>' + t[1] + '</p><button class="btn block" data-act="logout">Sair e usar outro e-mail</button></div></div>');
  }

  function showLogin(msg) {
    const L = S.login;
    let body;
    if (L.step === 'email') {
      body = '<form data-submit="loginPw" class="stack" novalidate>' +
        '<div class="field"><label class="f" for="lg-email">Seu e-mail</label>' +
        '<input class="input" id="lg-email" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required value="' + esc(L.email) + '" placeholder="nome@exemplo.com"></div>' +
        pwField('lg-pw', 'Senha', 'current-password', ' placeholder="Sua senha"') +
        '<button class="btn primary block" type="submit">Entrar</button>' +
        '<div class="row" style="align-items:center;gap:10px;margin:2px 0"><hr style="flex:1;margin:0"><span class="muted tiny">ou</span><hr style="flex:1;margin:0"></div>' +
        '<button class="btn block" type="button" data-act="loginCode">Receber código por e-mail</button>' +
        '<p class="hint">Primeiro acesso ou esqueceu a senha? Use o código por e-mail. Depois de entrar, você pode criar sua senha.</p></form>';
    } else {
      const wait = Math.max(0, Math.ceil((L.resendAt - Date.now()) / 1000));
      body = '<form data-submit="verifyCode" class="stack" novalidate>' +
        '<p>Enviamos um código para <b>' + esc(L.email) + '</b>. Confira também a caixa de spam.</p>' +
        '<div class="field"><label class="f" for="lg-code">Código</label>' +
        '<input class="input otp" id="lg-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="••••••" required></div>' +
        '<button class="btn primary block" type="submit">Entrar</button>' +
        '<div class="row between"><button type="button" class="btn ghost sm" data-act="loginBack">Usar outro e-mail</button>' +
        '<button type="button" class="btn ghost sm" data-act="resend" ' + (wait ? 'disabled' : '') + '>' + (wait ? 'Reenviar em ' + wait + ' s' : 'Reenviar código') + '</button></div>' +
        '<p class="hint">Você também pode tocar no link do e-mail. No iPhone, com o app instalado na tela inicial, prefira digitar o código.</p></form>';
    }
    setApp('<div class="center"><div class="login"><div class="logo"><img src="icons/icon-192.png" alt=""><h1>Plantão UTI</h1><div class="muted small">Escala, trocas e presença</div></div>' +
      '<div class="card">' + (msg ? '<div class="chip bad" style="white-space:normal;margin-bottom:12px;display:block;padding:8px 10px;border-radius:10px">' + esc(msg) + '</div>' : '') + body + '</div></div></div>');
    const f = L.step === 'email' ? $('#lg-email') : $('#lg-code');
    if (f) setTimeout(() => f.focus(), 50);
    if (L.step === 'code') refreshResendBtn();
  }
  function refreshResendBtn() {
    const b = document.querySelector('[data-act="resend"]'); if (!b) return;
    const wait = Math.max(0, Math.ceil((S.login.resendAt - Date.now()) / 1000));
    b.disabled = !!wait; b.textContent = wait ? 'Reenviar em ' + wait + ' s' : 'Reenviar código';
    if (wait) setTimeout(refreshResendBtn, 1000);
  }

  /* ---------- shell ---------- */
  const TABS = {
    gestor: [['agora', 'Agora'], ['escala', 'Escala'], ['trocas', 'Trocas'], ['presenca', 'Presença'], ['equipe', 'Equipe'], ['ajustes', 'Ajustes']],
    plantonista: [['meu', 'Meu plantão'], ['trocas', 'Trocas'], ['escala', 'Escala']]
  };
  function swapBadge() {
    if (S.role === 'gestor') return S.swaps.filter((w) => w.status === 'gestor').length;
    return S.swaps.filter((w) => w.status === 'colega' && w.to_doctor === S.me.id).length;
  }
  function isEditing() {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('#view') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }
  function render(force) {
    if (!S.started || !S.me) return;
    if (!force && isEditing()) { S.dirty = true; return; }
    S.dirty = false;
    const tabs = TABS[S.role];
    if (!tabs.some((t) => t[0] === S.tab)) S.tab = tabs[0][0];
    const badge = swapBadge();
    const views = { agora: viewAgora, escala: viewEscala, trocas: S.role === 'gestor' ? viewTrocasGestor : viewTrocasPlant, presenca: viewPresenca, equipe: viewEquipe, ajustes: viewAjustes, meu: viewMeu };
    let body;
    try { body = views[S.tab](); } catch (e) { console.error(e); body = '<div class="card">Erro ao montar a tela: ' + esc(e.message) + '</div>'; }
    const y = window.scrollY;
    setApp(
      '<header class="topbar"><div class="brand"><img src="icons/icon-192.png" alt=""><span>Plantão UTI</span></div><div class="spacer"></div>' +
      (isMgr() ? '<div class="seg" role="group" aria-label="Modo"><button data-act="role" data-role="gestor" class="' + (S.role === 'gestor' ? 'on' : '') + '">Gestor</button><button data-act="role" data-role="plantonista" class="' + (S.role === 'plantonista' ? 'on' : '') + '">Plantonista</button></div>' : '') +
      '<button class="acct" data-act="account" title="Minha conta" aria-label="Minha conta"><span class="who">' + esc(shortName(S.me.name)) + '</span><span class="avatar">' + esc((shortName(S.me.name)[0] || '?').toUpperCase()) + '</span></button></header>' +
      '<nav class="tabs" aria-label="Seções">' + tabs.map((t) => '<button data-act="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + ICON[t[0]] + '<span>' + t[1] + '</span>' + (t[0] === 'trocas' && badge ? '<span class="badge">' + badge + '</span>' : '') + '</button>').join('') + '</nav>' +
      '<main id="view">' + body + '</main>'
    );
    const tb = $('.topbar'); if (tb) document.documentElement.style.setProperty('--top-h', tb.offsetHeight + 'px');
    window.scrollTo(0, y);
    if (S.modal && S.modal.refresh) S.modal.refresh();
  }
  document.addEventListener('focusout', () => { setTimeout(() => { if (S.dirty && !isEditing()) render(); }, 400); });

  const chip = (label, tone) => '<span class="chip ' + (tone || '') + '">' + esc(label) + '</span>';
  const empty = (t) => '<div class="empty">' + t + '</div>';

  /* ---------- Gestor · Agora ---------- */
  function viewAgora() {
    const now = new Date();
    const slot = slotAt(now), prev = slotMove(slot, -1), next = slotMove(slot, 1);
    const st = slotStart(slot.date, slot.turn);
    const pct = Math.min(100, Math.max(0, (now - st) / (12 * HOUR) * 100));
    let present = 0;
    const cards = S.hospitals.map((h) => {
      const us = S.units.filter((u) => u.hospital_id === h.id);
      if (!us.length) return '';
      return '<div class="hosp-h">' + esc(h.name) + (h.lat == null ? ' · ' + chip('sem localização', 'warn') : '') + '</div><div class="grid cols2">' + us.map((u) => {
        const id = sid(slot.date, slot.turn, u.id); const doc = docOf(id);
        const s = attStatus(id, doc, now);
        if (s.code === 'presente') present++;
        const d = doc ? docById(doc) : null;
        const pid = sid(prev.date, prev.turn, u.id), pdoc = docOf(pid), pa = pdoc ? attOf(pid, pdoc) : null;
        const nid = sid(next.date, next.turn, u.id), ndoc = docOf(nid);
        const tone = { ok: 'st-ok', warn: 'st-warn', bad: 'st-bad', info: 'st-info', muted: 'st-muted' }[s.tone];
        return '<div class="card unit ' + tone + '"><div class="row between"><span class="uname">' + esc(u.name) + '</span>' + chip(s.label, s.tone) + '</div>' +
          '<div class="doc">' + (doc ? esc(docScaleName(doc)) : '<span class="muted">Sem escala</span>') + '</div>' +
          (d && d.phone ? '<div class="sub"><a href="tel:' + esc(String(d.phone).replace(/[^\d+]/g, '')) + '">' + esc(d.phone) + '</a></div>' : '') +
          (pa && pa.check_in && !pa.check_out ? '<div class="sub">' + chip('Check-out pendente', 'warn') + ' do turno anterior: ' + esc(docHistName(pdoc)) + '</div>' : '') +
          '<div class="sub">Próximo (' + turnName(next.turn).toLowerCase() + ' ' + fmtDM(next.date) + '): ' + (ndoc ? esc(docScaleName(ndoc)) : '<i>sem escala</i>') + '</div></div>';
      }).join('') + '</div>';
    }).join('');
    return pushBanner() + '<div class="card"><div class="row between"><div><div class="clock">' + fmtHM(now) + '</div><div class="muted">' + fmtDay(ymd(now)) + '</div></div>' +
      '<div style="text-align:right"><div class="kpi">' + present + ' de ' + S.units.length + '</div><div class="muted small">UTIs com plantonista presente</div></div></div>' +
      '<div class="row between small" style="margin-top:10px"><b>' + turnName(slot.turn) + ' ' + fmtDM(slot.date) + ' · ' + turnHours(slot.turn) + '</b><span class="muted">' + Math.round(pct) + '%</span></div>' +
      '<div class="progress"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>' + cards +
      '<p class="muted tiny" style="margin-top:14px">Atualiza sozinho a cada 30 s e quando alguém registra presença.</p>';
  }

  /* ---------- Escala (gestor edita; plantonista só lê) ---------- */
  function viewEscala() {
    const ws = S.week, days = [...Array(7)].map((_, i) => ymd(addDays(ws, i)));
    const now = new Date(), today = ymd(now), slot = slotAt(now);
    const mgr = S.role === 'gestor';
    if (!S.range || days[0] < S.range.from || days[6] > S.range.to) {
      ensureRange(ymd(addDays(ws, -7)), days[6]).then(() => render(true)).catch((e) => toast(errText(e), 'bad'));
      return '<div class="center" style="min-height:40vh"><div class="spinner"></div></div>';
    }
    // conflitos: mesmo médico em duas UTIs no mesmo turno
    const conflict = new Set();
    days.forEach((d) => ['D', 'N'].forEach((t) => {
      const seen = {};
      S.units.forEach((u) => { const doc = docOf(sid(d, t, u.id)); if (doc) { if (seen[doc]) { conflict.add(sid(d, t, u.id)); conflict.add(seen[doc]); } else seen[doc] = sid(d, t, u.id); } });
    }));
    let rows = '';
    selectedHospitals().forEach((h) => {
      const us = S.units.filter((u) => u.hospital_id === h.id); if (!us.length) return;
      rows += '<tr class="hrow"><td colspan="9">' + esc(h.name) + '</td></tr>';
      us.forEach((u) => ['D', 'N'].forEach((t, ti) => {
        rows += '<tr>' + (ti === 0 ? '<th class="uh" rowspan="2"><b>' + esc(u.name) + '</b><span>' + esc(h.name) + '</span></th>' : '') +
          '<td class="tlabel" title="' + turnName(t) + ' ' + turnHours(t) + '">' + t + '</td>' +
          days.map((d) => {
            const id = sid(d, t, u.id), doc = docOf(id);
            const mine = doc && doc === S.me.id, future = shiftStart(id) > now;
            const removed = doc && (!docById(doc) || !docById(doc).active);
            const pend = pendingSwapFor(id);
            const cls = ['cell', !doc ? 'empty-c' : '', conflict.has(id) ? 'conflict' : '', !mgr && mine ? 'mine' : '', mgr && mine ? 'mine' : '', removed ? 'removed' : '', pend ? 'pending' : ''];
            let act = '';
            if (mgr) { act = ' data-act="cell" data-id="' + id + '"'; cls.push('click'); }
            else if (mine && future && !pend) { act = ' data-act="offer" data-id="' + id + '"'; cls.push('click'); }
            const title = shiftDesc(id) + (doc ? ' — ' + docScaleName(doc) : '') + (conflict.has(id) ? ' (conflito)' : '') + (pend ? ' (troca em andamento)' : '');
            return '<td class="' + (d === today ? 'todaycol ' : '') + (d === slot.date && t === slot.turn ? 'nowcell' : '') + '"><button class="' + cls.join(' ') + '"' + act + ' title="' + esc(title) + '">' + (doc ? esc(shortName(docScaleName(doc))) : '—') + '</button></td>';
          }).join('') + '</tr>';
      }));
    });
    return '<div class="section-h"><div class="weeknav"><button class="btn sm" data-act="week" data-d="-7" aria-label="Semana anterior">‹</button><span class="lbl">' + weekLabel(ws) + '</span><button class="btn sm" data-act="week" data-d="7" aria-label="Próxima semana">›</button><button class="btn sm ghost" data-act="week" data-d="0">Hoje</button></div>' +
      '<div class="row" style="gap:6px">' + (mgr ? '<button class="btn sm" data-act="pdfOpen">PDF do mês</button><button class="btn sm" data-act="repeatWeek">Repetir semana anterior nos vazios</button>' : '') + '</div></div>' +
      filterChips() +
      '<div class="scroll-x"><table class="sched"><thead><tr><th class="uh" style="z-index:3">UTI</th><th></th>' +
      days.map((d) => '<th class="' + (d === today ? 'today' : '') + '">' + fmtDay(d) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="legend"><span>D = diurno 7h–19h · N = noturno 19h–7h</span><span><i style="background:var(--brand-soft)"></i>' + (mgr ? 'Seus plantões' : 'Seus plantões (toque para oferecer troca)') + '</span><span><i style="background:var(--bad-soft)"></i>Conflito</span><span><i style="box-shadow:inset 0 0 0 2px var(--warn)"></i>Troca em andamento</span></div>';
  }

  function filterChips() {
    const vis = visibleHospitals(); if (vis.length < 2) return '';
    const sel = new Set(selectedHospitals().map((h) => h.id)), all = sel.size === vis.length;
    return '<div class="chips no-print" role="group" aria-label="Escalas exibidas"><button class="fchip' + (all ? ' on' : '') + '" data-act="fAll">Todas</button>' +
      vis.map((h) => '<button class="fchip' + (!all && sel.has(h.id) ? ' on' : '') + '" data-act="fToggle" data-id="' + h.id + '">' + esc(h.name) + '</button>').join('') + '</div>';
  }

  /* ---------- Trocas (descrição) ---------- */
  function swapLine(w) {
    const perm = !!w.return_shift_id;
    return '<div class="title">' + esc(docHistName(w.from_doctor)) + '<span class="swap-arrow">' + (perm ? '⇄' : '→') + '</span>' + esc(docHistName(w.to_doctor)) + ' ' + chip(perm ? 'Permuta' : 'Repasse', 'brand') + '</div>' +
      '<div class="small">' + esc(docHistName(w.from_doctor).split(' (')[0]) + ' entrega: <b>' + esc(shiftDesc(w.shift_id)) + '</b></div>' +
      (perm ? '<div class="small">' + esc(docHistName(w.to_doctor).split(' (')[0]) + ' entrega: <b>' + esc(shiftDesc(w.return_shift_id)) + '</b></div>' : '') +
      (w.note ? '<div class="note">' + esc(w.note) + '</div>' : '') +
      '<div class="muted tiny" style="margin-top:4px">Pedido em ' + fmtDT(w.created_at) + (w.colleague_at ? ' · colega respondeu em ' + fmtDT(w.colleague_at) : '') + (w.decided_at ? ' · gestor decidiu em ' + fmtDT(w.decided_at) + (w.decided_by ? ' (' + esc(shortName(docHistName(w.decided_by))) + ')' : '') : '') + '</div>';
  }
  const STATUS = { colega: ['Aguardando colega', 'info'], gestor: ['Aguardando gestor', 'warn'], aprovada: ['Aprovada', 'ok'], recusada: ['Recusada pelo colega', 'bad'], negada: ['Não autorizada', 'bad'], cancelada: ['Cancelada', ''] };
  const statusChip = (s) => chip(STATUS[s][0], STATUS[s][1]);

  function viewTrocasGestor() {
    const wait = S.swaps.filter((w) => w.status === 'gestor');
    const col = S.swaps.filter((w) => w.status === 'colega');
    const hist = S.swaps.filter((w) => w.status !== 'gestor' && w.status !== 'colega').slice(0, 60);
    return '<div class="section-h"><h2>Aguardando sua autorização</h2>' + (wait.length ? chip(String(wait.length), 'warn') : '') + '</div>' +
      (wait.length ? '<div class="list">' + wait.map((w) => '<div class="card item"><div class="main">' + swapLine(w) + '</div></div><div class="row" style="margin:-4px 0 6px;justify-content:flex-end"><button class="btn danger sm" data-act="decide" data-id="' + w.id + '" data-ok="0">Não autorizar</button><button class="btn ok sm" data-act="decide" data-id="' + w.id + '" data-ok="1">Autorizar</button></div>').join('') + '</div>' : empty('Nenhum pedido aguardando autorização.')) +
      '<div class="section"><div class="section-h"><h2>Aguardando o colega</h2></div>' + (col.length ? '<div class="list">' + col.map((w) => '<div class="card item"><div class="main">' + swapLine(w) + '</div>' + statusChip(w.status) + '</div>').join('') + '</div>' : empty('Nenhum.')) + '</div>' +
      '<div class="section"><div class="section-h"><h2>Histórico</h2></div>' + (hist.length ? '<div class="list">' + hist.map((w) => '<div class="card item"><div class="main">' + swapLine(w) + '</div>' + statusChip(w.status) + '</div>').join('') + '</div>' : empty('Ainda não há trocas concluídas.')) + '</div>';
  }

  function viewTrocasPlant() {
    const me = S.me.id, now = new Date();
    const recv = S.swaps.filter((w) => w.status === 'colega' && w.to_doctor === me);
    const mine = S.swaps.filter((w) => (w.status === 'colega' || w.status === 'gestor') && w.from_doctor === me);
    const accepted = S.swaps.filter((w) => w.status === 'gestor' && w.to_doctor === me);
    const hist = S.swaps.filter((w) => !['colega', 'gestor'].includes(w.status) && (w.from_doctor === me || w.to_doctor === me)).slice(0, 30);
    const fut = myShifts().filter((s) => shiftStart(s.id) > now).slice(0, 20);
    return '<div class="section-h"><h2>Pedidos recebidos</h2>' + (recv.length ? chip(String(recv.length), 'bad') : '') + '</div>' +
      (recv.length ? '<div class="list">' + recv.map((w) => '<div class="card"><div class="item"><div class="main">' + swapLine(w) + '</div></div><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn danger sm" data-act="respond" data-id="' + w.id + '" data-ok="0">Recusar</button><button class="btn ok sm" data-act="respond" data-id="' + w.id + '" data-ok="1">Aceitar</button></div></div>').join('') + '</div>' : empty('Nenhum pedido recebido.')) +
      '<div class="section"><div class="section-h"><h2>Oferecer troca</h2></div>' + (fut.length ? '<div class="card"><div class="list">' + fut.map((s) => { const p = pendingSwapFor(s.id); return '<div class="item"><div class="main small"><b>' + esc(fmtDay(s.date)) + ' · ' + turnName(s.turn) + '</b><br><span class="muted">' + esc(unitFull(s.unit_id)) + '</span></div>' + (p ? chip('Troca em andamento', 'warn') : '<button class="btn sm" data-act="offer" data-id="' + s.id + '">Oferecer troca</button>') + '</div>'; }).join('<hr style="margin:0">') + '</div></div>' : empty('Você não tem plantões futuros na escala.')) + '</div>' +
      '<div class="section"><div class="section-h"><h2>Meus pedidos</h2></div>' + (mine.length ? '<div class="list">' + mine.map((w) => '<div class="card"><div class="item"><div class="main">' + swapLine(w) + '</div>' + statusChip(w.status) + '</div><div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn sm danger" data-act="cancelSwap" data-id="' + w.id + '">Cancelar pedido</button></div></div>').join('') + '</div>' : empty('Nenhum pedido em andamento.')) + '</div>' +
      '<div class="section"><div class="section-h"><h2>Trocas que aceitei</h2></div>' + (accepted.length ? '<div class="list">' + accepted.map((w) => '<div class="card item"><div class="main">' + swapLine(w) + '</div>' + statusChip(w.status) + '</div>').join('') + '</div>' : empty('Nenhuma aguardando o gestor.')) + '</div>' +
      (hist.length ? '<div class="section"><div class="section-h"><h2>Histórico</h2></div><div class="list">' + hist.map((w) => '<div class="card item"><div class="main">' + swapLine(w) + '</div>' + statusChip(w.status) + '</div>').join('') + '</div></div>' : '');
  }

  /* ---------- Gestor · Presença ---------- */
  function presenceRows() {
    const P = S.pres, now = new Date(), rows = [], seen = new Set();
    S.shifts.forEach((s) => {
      if (s.date < P.from || s.date > P.to || !s.doctor_id) return;
      if (P.doctor && s.doctor_id !== P.doctor) return;
      if (shiftStart(s.id) > now) return;
      seen.add(s.id + '|' + s.doctor_id);
      rows.push({ id: s.id, doc: s.doctor_id, outside: false });
    });
    S.att.forEach((a, k) => {
      if (seen.has(k) || a.shift_date < P.from || a.shift_date > P.to) return;
      if (P.doctor && a.doctor_id !== P.doctor) return;
      rows.push({ id: a.shift_id, doc: a.doctor_id, outside: true });
    });
    rows.forEach((r) => { Object.assign(r, classify(r.id, r.doc, now)); });
    rows.sort((a, b) => shiftStart(b.id) - shiftStart(a.id) || unitName(parseSid(a.id).unit).localeCompare(unitName(parseSid(b.id).unit)));
    return rows;
  }
  function viewPresenca() {
    const P = S.pres;
    if (P.from < S.range.from || P.to > S.range.to) {
      ensureRange(P.from, P.to).then(() => render(true)).catch((e) => toast(errText(e), 'bad'));
      return '<div class="center" style="min-height:40vh"><div class="spinner"></div></div>';
    }
    const rows = presenceRows();
    const sum = {};
    rows.forEach((r) => {
      const s = sum[r.doc] || (sum[r.doc] = { n: 0, ok: 0, late: 0, lateMin: 0, noin: 0, noout: 0, early: 0, ms: 0 });
      s.n++; s.ms += r.hoursMs; s.lateMin += r.lateMin;
      r.tags.forEach(([t]) => { if (t === 'Pontual') s.ok++; else if (t.startsWith('Atraso')) s.late++; else if (t === 'Sem check-in') s.noin++; else if (t === 'Sem check-out') s.noout++; else if (t === 'Saída antecipada') s.early++; });
    });
    const docs = S.doctors.slice().sort((a, b) => a.name.localeCompare(b.name));
    const sumRows = Object.keys(sum).map((d) => [d, sum[d]]).sort((a, b) => docHistName(a[0]).localeCompare(docHistName(b[0])));
    return '<div class="card no-print"><div class="grid cols3">' +
      '<div><label class="f" for="pf-from">De</label><input class="input" type="date" id="pf-from" value="' + P.from + '" data-change="presFilter"></div>' +
      '<div><label class="f" for="pf-to">Até</label><input class="input" type="date" id="pf-to" value="' + P.to + '" data-change="presFilter"></div>' +
      '<div><label class="f" for="pf-doc">Médico</label><select class="input" id="pf-doc" data-change="presFilter"><option value="">Todos</option>' + docs.map((d) => '<option value="' + d.id + '"' + (P.doctor === d.id ? ' selected' : '') + '>' + esc(d.name) + (d.active ? '' : ' (inativo)') + '</option>').join('') + '</select></div></div>' +
      '<div class="row between" style="margin-top:12px"><span class="muted small">Período de até 3 meses. Toque numa linha para ajustar entrada e saída.</span><button class="btn primary sm" data-act="csv">Exportar CSV</button></div></div>' +
      '<div class="section"><div class="section-h"><h2>Resumo por médico</h2></div>' + (sumRows.length ? '<div class="scroll-x"><table class="tbl"><thead><tr><th>Médico</th><th class="num">Plantões</th><th class="num">Pontuais</th><th class="num">Atrasos</th><th class="num">Min. atraso</th><th class="num">Sem check-in</th><th class="num">Sem check-out</th><th class="num">Saída antec.</th><th class="num">Horas</th></tr></thead><tbody>' +
        sumRows.map(([d, s]) => '<tr><td>' + esc(docHistName(d)) + '</td><td class="num">' + s.n + '</td><td class="num">' + s.ok + '</td><td class="num">' + s.late + '</td><td class="num">' + s.lateMin + '</td><td class="num">' + s.noin + '</td><td class="num">' + s.noout + '</td><td class="num">' + s.early + '</td><td class="num">' + fmtDur(s.ms) + '</td></tr>').join('') + '</tbody></table></div>' : empty('Nenhum plantão no período.')) + '</div>' +
      '<div class="section"><div class="section-h"><h2>Plantões</h2><span class="muted small">' + rows.length + '</span></div>' + (rows.length ? '<div class="scroll-x"><table class="tbl"><thead><tr><th>Data</th><th>Turno</th><th>UTI</th><th>Médico</th><th>Entrada</th><th>Saída</th><th class="num">Horas</th><th>Situação</th></tr></thead><tbody>' +
        rows.map((r) => { const p = parseSid(r.id), a = r.a || {}; return '<tr class="click" data-act="adjust" data-id="' + r.id + '" data-doc="' + r.doc + '"><td class="nowrap">' + fmtDay(p.date) + '</td><td>' + p.turn + '</td><td>' + esc(unitName(p.unit)) + '</td><td>' + esc(docHistName(r.doc)) + (r.outside ? '<div class="tiny muted">fora da escala atual</div>' : '') + '</td><td class="nowrap">' + (a.check_in ? fmtDT(a.check_in) + (a.in_dist != null ? '<div class="tiny muted">' + fmtDist(a.in_dist) + '</div>' : '') : '—') + '</td><td class="nowrap">' + (a.check_out ? fmtDT(a.check_out) + (a.out_dist != null ? '<div class="tiny muted">' + fmtDist(a.out_dist) + '</div>' : '') : '—') + '</td><td class="num">' + (r.hoursMs ? fmtDur(r.hoursMs) : '—') + '</td><td>' + r.tags.map((t) => chip(t[0], t[1])).join(' ') + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty('Nenhum plantão no período.')) + '</div>';
  }

  /* ---------- Gestor · Equipe ---------- */
  function viewEquipe() {
    const list = S.doctors.slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    return '<div class="section-h"><h2>Equipe <span class="muted small">(' + S.doctors.filter((d) => d.active).length + ' ativos)</span></h2><button class="btn primary sm" data-act="docEdit">+ Novo médico</button></div>' +
      (list.length ? '<div class="list">' + list.map((d) => '<div class="card item" ' + (d.active ? '' : 'style="opacity:.65"') + '><div class="main"><div class="title">' + esc(d.name) + (d.id === S.me.id ? ' <span class="muted small">(você)</span>' : '') + '</div>' +
        '<div class="small muted">' + esc(d.email) + (d.crm ? ' · CRM ' + esc(d.crm) : '') + (d.phone ? ' · ' + esc(d.phone) : '') + '</div>' +
        '<div class="small" style="margin-top:4px">' + (docHosps(d.id) ? esc(S.hospitals.filter((h) => docHosps(d.id).has(h.id)).map((h) => h.name).join(', ')) : '<span class="muted">Todos os hospitais</span>') + '</div>' +
        '<div class="row" style="margin-top:6px;gap:6px">' + (d.is_manager ? chip('Gestor', 'brand') : '') + (d.active ? '' : chip('Inativo', 'bad')) + (d.user_id ? chip('Já entrou no app', 'ok') : chip('Ainda não entrou', '')) + '</div></div>' +
        '<div class="actions"><button class="btn sm" data-act="docEdit" data-id="' + d.id + '">Editar</button></div></div>').join('') + '</div>' : empty('Nenhum médico cadastrado.')) +
      '<p class="muted tiny" style="margin-top:12px">O médico entra com o mesmo e-mail cadastrado aqui. Só quem já entrou no app pode receber pedidos de troca. Para remover alguém, desative o cadastro: o histórico de presença é preservado.</p>';
  }

  /* ---------- Gestor · Ajustes ---------- */
  function viewAjustes() {
    const st = S.settings;
    return '<div class="section-h"><h2>Hospitais</h2></div><div class="grid cols2">' + S.hospitals.map((h) =>
      '<form class="card stack" data-submit="saveHosp" data-id="' + h.id + '"><div class="field"><label class="f">Nome</label><input class="input" name="name" required maxlength="80" value="' + esc(h.name) + '"></div>' +
      '<div class="field"><label class="f">Coordenadas (latitude, longitude)</label><input class="input" name="coords" placeholder="-23.1857, -46.8978" value="' + (h.lat != null ? h.lat + ', ' + h.lng : '') + '"><div class="hint" data-hint>No Google Maps, toque e segure no prédio e copie os números. Ou use o botão abaixo estando no hospital.</div></div>' +
      '<button type="button" class="btn sm" data-act="hereCoords">' + ICON.pin + ' Usar minha localização atual</button>' +
      '<div class="field"><label class="f">Raio do check-in (metros)</label><input class="input" name="radius" type="number" min="50" max="2000" step="10" value="' + h.radius_m + '"><div class="hint">50 a 2000 m. 200 a 400 m costuma cobrir prédio e estacionamento.</div></div>' +
      (h.lat != null ? '<a class="small" target="_blank" rel="noopener" href="https://www.google.com/maps?q=' + h.lat + ',' + h.lng + '">Conferir no mapa ↗</a>' : '') +
      '<button class="btn primary" type="submit">Salvar hospital</button></form>').join('') + '</div>' +
      '<div class="section"><div class="section-h"><h2>UTIs</h2></div><div class="grid cols2">' + S.units.map((u) =>
        '<form class="card stack" data-submit="saveUnit" data-id="' + u.id + '"><div class="field"><label class="f">Nome da UTI</label><input class="input" name="name" required maxlength="60" value="' + esc(u.name) + '"></div>' +
        '<div class="field"><label class="f">Hospital</label><select class="input" name="hospital">' + S.hospitals.map((h) => '<option value="' + h.id + '"' + (h.id === u.hospital_id ? ' selected' : '') + '>' + esc(h.name) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" type="submit">Salvar UTI</button></form>').join('') + '</div></div>' +
      '<div class="section"><div class="section-h"><h2>Pontualidade</h2></div><form class="card stack" data-submit="saveSettings" style="max-width:560px">' +
      '<div class="field"><label class="f">Tolerância de atraso (min)</label><input class="input" name="tol" type="number" min="0" max="60" value="' + st.tolerance_min + '"><div class="hint">Check-in até o início + tolerância conta como pontual. 0 a 60.</div></div>' +
      '<div class="field"><label class="f">Abertura do check-in (min antes do turno)</label><input class="input" name="early" type="number" min="0" max="180" value="' + st.early_min + '"><div class="hint">0 a 180.</div></div>' +
      '<button class="btn primary" type="submit">Salvar pontualidade</button></form></div>' +
      '<p class="muted tiny" style="margin-top:14px">Criar ou remover hospitais e UTIs é feito pela TI, direto no banco. Fuso do servidor: ' + esc(st.tz) + '.</p>';
  }

  /* ---------- Plantonista · Meu plantão ---------- */
  function viewMeu() {
    const now = new Date(), early = S.settings.early_min * MIN, tol = S.settings.tolerance_min * MIN;
    const mine = myShifts();
    const cards = [];
    // check-out pendente (até 18 h após o início)
    S.att.forEach((a) => {
      if (a.doctor_id !== S.me.id || !a.check_in || a.check_out) return;
      const st = shiftStart(a.shift_id);
      if (now - st <= 18 * HOUR) cards.push({ id: a.shift_id, kind: 'out', a });
    });
    // check-in aberto
    mine.forEach((s) => {
      const st = shiftStart(s.id), en = shiftEnd(s.id), a = attOf(s.id, S.me.id);
      if (now >= st - early && now < en && !(a && a.check_in)) cards.push({ id: s.id, kind: 'in' });
    });
    cards.sort((x, y) => shiftStart(x.id) - shiftStart(y.id));
    let hero = '';
    if (cards.length) {
      hero = cards.map((c) => {
        const st = shiftStart(c.id), en = shiftEnd(c.id), p = parseSid(c.id);
        if (c.kind === 'in') {
          const late = now - st > tol;
          return '<div class="card hero stack"><div class="row between"><span class="chip brand">Plantão ' + (now >= st ? 'em andamento' : 'abre em breve') + '</span>' + (now >= st ? chip(late ? 'Atrasado ' + Math.round((now - st) / MIN) + ' min' : 'No horário', late ? 'warn' : 'ok') : chip('Começa às ' + fmtHM(st), 'info')) + '</div>' +
            '<div><div class="when">' + turnName(p.turn) + ' · ' + fmtDay(p.date) + '</div><div class="where">' + esc(unitFull(p.unit)) + ' · ' + fmtHM(st) + '–' + fmtHM(en) + '</div></div>' +
            '<button class="btn primary big" data-act="checkin" data-id="' + c.id + '">' + ICON.pin + ' Fazer check-in</button><div class="hint">O app vai pedir sua localização uma única vez, só para conferir se você está no hospital. As coordenadas não são guardadas.</div></div>';
        }
        const ci = new Date(c.a.check_in), lateMin = ci - st > tol ? Math.round((ci - st) / MIN) : 0;
        return '<div class="card hero stack"><div class="row between"><span class="chip ok">Você está de plantão</span>' + chip(lateMin ? 'Entrada com atraso ' + lateMin + ' min' : 'Entrada no horário', lateMin ? 'warn' : 'ok') + '</div>' +
          '<div><div class="when">' + turnName(p.turn) + ' · ' + fmtDay(p.date) + '</div><div class="where">' + esc(unitFull(p.unit)) + '</div></div>' +
          '<div class="row small"><span>Entrada: <b>' + fmtHM(ci) + '</b></span><span class="muted">Término: ' + fmtHM(en) + (now > en ? ' (já passou)' : '') + '</span></div>' +
          '<button class="btn big ' + (now >= en - tol ? 'primary' : '') + '" data-act="checkout" data-id="' + c.id + '">' + ICON.out + ' Fazer check-out</button></div>';
      }).join('');
    } else {
      const nx = mine.find((s) => shiftStart(s.id) > now);
      if (nx) {
        const st = shiftStart(nx.id), open = new Date(st - early);
        hero = '<div class="card stack"><span class="chip">Próximo plantão</span><div><div class="when" style="font-size:1.2rem;font-weight:700">' + turnName(nx.turn) + ' · ' + fmtDay(nx.date) + '</div><div class="muted">' + esc(unitFull(nx.unit_id)) + ' · ' + turnHours(nx.turn) + '</div></div>' +
          '<div class="small">O check-in abre às <b>' + fmtHM(open) + '</b>' + (ymd(open) !== ymd(now) ? ' de ' + fmtDay(ymd(open)) : '') + '.</div></div>';
      } else hero = empty('Você não tem plantões nos próximos dias.');
    }
    const fut = mine.filter((s) => shiftStart(s.id) > now && !cards.some((c) => c.id === s.id)).slice(0, 12);
    const recent = [...S.att.values()].filter((a) => a.doctor_id === S.me.id && (a.check_in || a.check_out)).sort((a, b) => shiftStart(b.shift_id) - shiftStart(a.shift_id)).slice(0, 8);
    return pushBanner() + '<div class="stack">' + hero + '</div>' +
      '<div class="section"><div class="section-h"><h2>Próximos plantões</h2></div>' + (fut.length ? '<div class="card"><div class="list">' + fut.map((s) => { const p = pendingSwapFor(s.id); return '<div class="item"><div class="main small"><b>' + esc(fmtDay(s.date)) + ' · ' + turnName(s.turn) + ' ' + turnHours(s.turn) + '</b><br><span class="muted">' + esc(unitFull(s.unit_id)) + '</span></div>' + (p ? chip('Troca em andamento', 'warn') : '<button class="btn sm" data-act="offer" data-id="' + s.id + '">Oferecer troca</button>') + '</div>'; }).join('<hr style="margin:0">') + '</div></div>' : empty('Nenhum plantão futuro na escala.')) + '</div>' +
      '<div class="section"><div class="section-h"><h2>Últimos registros</h2></div>' + (recent.length ? '<div class="card"><div class="list">' + recent.map((a) => { const c = classify(a.shift_id, a.doctor_id, now), p = parseSid(a.shift_id); return '<div class="item"><div class="main small"><b>' + fmtDay(p.date) + ' · ' + turnName(p.turn) + '</b> · ' + esc(unitName(p.unit)) + '<br><span class="muted">Entrada ' + (a.check_in ? fmtHM(a.check_in) : '—') + ' · Saída ' + (a.check_out ? fmtDT(a.check_out) : '—') + '</span></div><div class="actions">' + c.tags.map((t) => chip(t[0], t[1])).join('') + '</div></div>'; }).join('<hr style="margin:0">') + '</div></div>' : empty('Nenhum registro ainda.')) + '</div>';
  }

  /* ================================= modal ================================= */
  function openModal(title, html, opts) {
    opts = opts || {};
    const m = $('#modal');
    m.innerHTML = '<div class="back" data-act="mclose"></div><div class="sheet"><div class="mh"><h2>' + esc(title) + '</h2><button class="iconbtn" data-act="mclose" aria-label="Fechar">' + ICON.x + '</button></div><div id="mbody">' + html + '</div></div>';
    m.classList.add('open');
    S.modal = { onClose: opts.onClose, refresh: opts.refresh };
    const f = m.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 50);
  }
  function setModalBody(html) { const b = $('#mbody'); if (b) b.innerHTML = html; }
  function closeModal() {
    const m = $('#modal'); if (!m) return;
    const cb = S.modal && S.modal.onClose; S.modal = null;
    m.classList.remove('open'); m.innerHTML = '';
    if (cb) cb();
  }
  function confirmBox(title, msg, okLabel, danger) {
    return new Promise((resolve) => {
      let done = false;
      openModal(title, '<p>' + msg + '</p><div class="mf"><button class="btn" data-act="mclose">Voltar</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-act="mok">' + esc(okLabel || 'Confirmar') + '</button></div>',
        { onClose: () => { if (!done) resolve(false); } });
      S.modal.ok = () => { done = true; closeModal(); resolve(true); };
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) closeModal(); });

  function toast(msg, kind, ms) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || ''); t.textContent = msg; t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    $('#toast').appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === 'bad' ? 8000 : 3500));
    t.addEventListener('click', () => t.remove());
  }

  /* ================================ geolocation ============================= */
  function getPos() {
    return new Promise((resolve, reject) => {
      if (!window.isSecureContext) return reject(new Error('A localização só funciona com o app aberto em endereço https://.'));
      if (!navigator.geolocation) return reject(new Error('Este navegador não oferece localização.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => {
          if (e.code === 1) reject(new Error('A permissão de localização foi negada. Para liberar: no iPhone, Ajustes > Privacidade e Segurança > Serviços de Localização > Safari (ou "Sites do Safari") > "Ao Usar o App"; no Android, toque no cadeado ao lado do endereço > Permissões > Localização > Permitir. Depois tente de novo.'));
          else if (e.code === 3) reject(new Error('A localização demorou demais. Vá para perto de uma janela ou área aberta e tente de novo.'));
          else reject(new Error('Localização indisponível. Confira se a localização (GPS) do celular está ligada e tente de novo.'));
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }
  function parseCoords(s) {
    s = String(s || '').trim(); if (!s) return null;
    let m = s.match(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/) || s.match(/(-?\d{1,3},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)/);
    if (!m) return undefined;
    const lat = parseFloat(m[1].replace(',', '.')), lng = parseFloat(m[2].replace(',', '.'));
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return undefined;
    return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
  }

  /* ================================= actions ================================ */
  async function busy(el, label, fn) {
    if (el && el.disabled) return;
    const old = el ? el.innerHTML : '';
    if (el) { el.disabled = true; el.classList.add('busy'); if (label) el.textContent = label; }
    try { return await fn(); }
    catch (e) { toast(errText(e), 'bad'); }
    finally { if (el && el.isConnected) { el.disabled = false; el.classList.remove('busy'); el.innerHTML = old; } }
  }
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };

  const A = {
    reload: () => location.reload(),
    account: () => openAccount(),
    pwEye: (el) => {
      const i = $('#' + el.dataset.for); if (!i) return;
      const show = i.type === 'password'; i.type = show ? 'text' : 'password';
      el.innerHTML = show ? ICON.eyeOff : ICON.eye;
      el.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha'); el.title = el.getAttribute('aria-label');
      i.focus();
    },
    pwOpen: () => openPwModal(false),
    pwLater: () => { try { sessionStorage.setItem('plantao-pw-later', '1'); } catch (e) { /* */ } closeModal(); },
    loginCode: (el) => {
      const email = ($('#lg-email').value || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Digite seu e-mail primeiro.', 'bad'); return; }
      S.login.email = email;
      return busy(el, 'Enviando…', async () => { await sendOtp(email); S.login.step = 'code'; showLogin(); });
    },
    pushOn: (el) => busy(el, 'Ativando…', async () => { await enablePush(); await rpc('send_test_push'); toast('Notificações ativadas. Enviamos um teste.', 'ok', 5000); await refreshPushState(); renderPushBox(); }),
    pushOff: (el) => busy(el, 'Desativando…', async () => { await disablePush(false); await refreshPushState(); renderPushBox(); toast('Notificações desativadas neste aparelho.'); }),
    pushTest: (el) => busy(el, 'Enviando…', async () => { await rpc('send_test_push'); toast('Teste enviado. Deve chegar em alguns segundos.', 'ok'); }),
    pushDismiss: () => { try { localStorage.setItem('plantao-push-dismiss', String(Date.now())); } catch (e) { /* */ } render(true); },
    fAll: () => { setFilter(visibleHospitals().map((h) => h.id)); render(true); },
    fToggle: (el) => {
      const vis = visibleHospitals().map((h) => h.id), cur = selectedHospitals().map((h) => h.id), id = el.dataset.id;
      let next = cur.length === vis.length ? [id] : (cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id));
      if (!next.length) next = vis;
      setFilter(next); render(true);
    },
    pdfOpen: () => openPdfModal(),
    pdfGo: (el) => {
      const from = $('#pdf-from').value, to = $('#pdf-to').value, hs = [...document.querySelectorAll('[name=pdf-h]:checked')].map((i) => i.value);
      if (!from || !to || from > to) { toast('Confira as datas.', 'bad'); return; }
      if (parseYmd(to) - parseYmd(from) > 370 * DAY) { toast('O período máximo é de 12 meses.', 'bad'); return; }
      if (!hs.length) { toast('Escolha ao menos um hospital.', 'bad'); return; }
      return busy(el, 'Gerando…', async () => { await generatePdf(from, to, hs); closeModal(); toast('PDF gerado.', 'ok'); });
    },
    logout: () => logout(),
    mclose: () => closeModal(),
    mok: () => { if (S.modal && S.modal.ok) S.modal.ok(); },
    tab: (el) => { S.tab = el.dataset.tab; window.scrollTo(0, 0); render(true); },
    role: (el) => { S.role = el.dataset.role; S.tab = null; window.scrollTo(0, 0); render(true); },
    loginBack: () => { S.login.step = 'email'; showLogin(); },
    resend: (el) => busy(el, 'Enviando…', async () => { await sendOtp(S.login.email); toast('Novo código enviado.', 'ok'); showLogin(); }),

    week: (el) => {
      const d = +el.dataset.d;
      S.week = d === 0 ? startOfWeek(new Date()) : addDays(S.week, d);
      render(true);
    },

    /* gestor: escalar */
    cell: (el) => openCellModal(el.dataset.id),
    pickDoc: async (el) => {
      const id = S.modal && S.modal.shiftId; if (!id) return;
      const doc = el.dataset.doc || null; const p = parseSid(id);
      const prev = S.shifts.get(id);
      // mostra o resultado na hora; grava em segundo plano e desfaz se der erro
      if (doc) S.shifts.set(id, { id, date: p.date, turn: p.turn, unit_id: p.unit, doctor_id: doc }); else S.shifts.delete(id);
      closeModal(); render(true);
      const q = doc
        ? sb.from('shifts').upsert({ id, date: p.date, turn: p.turn, unit_id: p.unit, doctor_id: doc })
        : sb.from('shifts').delete().eq('id', id);
      const { error } = await q;
      if (error) {
        if (prev) S.shifts.set(id, prev); else S.shifts.delete(id);
        render(true); toast('Não foi possível salvar a escala: ' + errText(error), 'bad');
      }
    },
    repeatWeek: async (el) => {
      const ws = S.week, now = new Date(), rows = [];
      for (let i = 0; i < 7; i++) {
        const d = ymd(addDays(ws, i)), pd = ymd(addDays(ws, i - 7));
        for (const u of S.units) for (const t of ['D', 'N']) {
          const id = sid(d, t, u.id);
          if (docOf(id) || shiftStart(id) <= now) continue;
          const prev = docOf(sid(pd, t, u.id)); const pdoc = prev && docById(prev);
          if (pdoc && pdoc.active) rows.push({ id, date: d, turn: t, unit_id: u.id, doctor_id: prev });
        }
      }
      if (!rows.length) { toast('Nada a preencher: os vazios desta semana também estão vazios na anterior (plantões já iniciados não são alterados).'); return; }
      if (!(await confirmBox('Repetir semana anterior', 'Preencher <b>' + rows.length + '</b> plantões vazios desta semana com quem estava na mesma UTI e turno na semana anterior? Plantões já preenchidos e já iniciados não mudam.', 'Preencher'))) return;
      await busy(el, 'Preenchendo…', async () => {
        const { error } = await sb.from('shifts').upsert(rows); if (error) throw error;
        await loadShifts(); render(true); toast(rows.length + ' plantões preenchidos.', 'ok');
      });
    },

    /* trocas */
    offer: (el) => openSwapModal(el.dataset.id),
    swTo: (el) => { if (el.classList.contains('dis')) return; const f = S.modal.form; f.to = el.dataset.doc; f.ret = null; refreshSwapModal(); },
    swType: (el) => { const f = S.modal.form; f.type = el.dataset.type; f.ret = null; refreshSwapModal(); },
    swRet: (el) => { if (el.classList.contains('dis')) return; S.modal.form.ret = el.dataset.id; refreshSwapModal(); },
    swSend: async (el) => {
      const f = S.modal.form;
      if (!f.to) { toast('Escolha o colega.', 'bad'); return; }
      if (f.type === 'permuta' && !f.ret) { toast('Escolha o plantão do colega que você assume.', 'bad'); return; }
      await busy(el, 'Enviando…', async () => {
        await rpc('request_swap', { p_shift: f.shift, p_to: f.to, p_return: f.type === 'permuta' ? f.ret : null, p_note: f.note || null });
        await loadSwaps(); closeModal(); render(true);
        toast('Pedido enviado a ' + shortName(docHistName(f.to)) + '. Depois do aceite, o gestor autoriza.', 'ok', 5000);
      });
    },
    respond: async (el) => {
      const ok = el.dataset.ok === '1', w = S.swaps.find((x) => x.id === el.dataset.id);
      if (!ok && !(await confirmBox('Recusar troca', 'Recusar o pedido de ' + esc(docHistName(w.from_doctor)) + '?', 'Recusar', true))) return;
      if (ok && !(await confirmBox('Aceitar troca', 'Ao aceitar, o pedido vai para o gestor autorizar. A escala só muda depois da autorização.<br><br>' + swapLine(w), 'Aceitar'))) return;
      await busy(el, null, async () => { await rpc('respond_swap', { p_id: el.dataset.id, p_accept: ok }); await loadSwaps(); render(true); toast(ok ? 'Aceito. Aguardando o gestor.' : 'Pedido recusado.', ok ? 'ok' : ''); });
    },
    cancelSwap: async (el) => {
      if (!(await confirmBox('Cancelar pedido', 'Desistir deste pedido de troca?', 'Cancelar pedido', true))) return;
      await busy(el, null, async () => { await rpc('cancel_swap', { p_id: el.dataset.id }); await loadSwaps(); render(true); toast('Pedido cancelado.'); });
    },
    decide: async (el) => {
      const ok = el.dataset.ok === '1', w = S.swaps.find((x) => x.id === el.dataset.id);
      if (!(await confirmBox(ok ? 'Autorizar troca' : 'Não autorizar troca', (ok ? 'A escala será atualizada agora.' : 'O pedido será encerrado e a escala não muda.') + '<br><br>' + swapLine(w), ok ? 'Autorizar' : 'Não autorizar', !ok))) return;
      await busy(el, null, async () => {
        await rpc('decide_swap', { p_id: el.dataset.id, p_approve: ok });
        await Promise.all([loadSwaps(), loadShifts()]); render(true);
        toast(ok ? 'Troca autorizada. Escala atualizada.' : 'Troca não autorizada.', ok ? 'ok' : '');
      });
    },

    /* presença */
    checkin: (el) => doPresence(el, 'in'),
    checkout: async (el) => {
      const en = shiftEnd(el.dataset.id), tol = S.settings.tolerance_min * MIN;
      if (new Date() < en - tol && !(await confirmBox('Saída antecipada', 'Seu plantão termina às <b>' + fmtHM(en) + '</b>. Registrar a saída agora? Ela aparecerá como <b>saída antecipada</b> no relatório.', 'Registrar saída', true))) return;
      doPresence(el, 'out');
    },
    adjust: (el) => openAdjustModal(el.dataset.id, el.dataset.doc),
    adjClear: (el) => { const i = $('#' + el.dataset.for); if (i) i.value = ''; },
    adjSave: async (el) => {
      const ci = $('#adj-in').value, co = $('#adj-out').value, m = S.modal;
      await busy(el, 'Salvando…', async () => {
        await rpc('manager_set_attendance', { p_shift: m.shiftId, p_doctor: m.doc, p_in: fromLocalInput(ci), p_out: fromLocalInput(co) });
        await loadAtt(); closeModal(); render(true); toast('Presença ajustada.', 'ok');
      });
    },
    csv: () => exportCsv(),

    /* equipe */
    docEdit: (el) => openDocModal(el.dataset.id),
    docUnlink: async (el) => {
      const d = docById(el.dataset.id);
      if (!(await confirmBox('Desvincular login', 'Desvincular o login de <b>' + esc(d.name) + '</b>? No próximo acesso, a conta será vinculada de novo ao cadastro com o e-mail atual. Use isso se o e-mail do médico mudou.', 'Desvincular', true))) return;
      await busy(el, null, async () => { const { error } = await sb.from('doctors').update({ user_id: null }).eq('id', d.id); if (error) throw error; await loadStatic(); render(true); toast('Login desvinculado.'); });
    },

    /* ajustes */
    hereCoords: (el) => busy(el, 'Obtendo localização…', async () => {
      const p = await getPos(), form = el.closest('form');
      form.querySelector('[name=coords]').value = p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);
      const h = form.querySelector('[data-hint]'); if (h) h.textContent = 'Localização capturada (precisão ± ' + Math.round(p.acc) + ' m). Confira e toque em Salvar.';
      if (p.acc > 100) toast('Precisão baixa (± ' + Math.round(p.acc) + ' m). Se puder, tente de novo perto de uma janela.', 'bad');
    })
  };

  async function doPresence(el, kind) {
    const id = el.dataset.id;
    await busy(el, 'Obtendo localização…', async () => {
      const p = await getPos();
      el.textContent = 'Registrando…';
      const { data, error } = await sb.rpc(kind === 'in' ? 'check_in' : 'check_out', { p_shift: id, p_lat: p.lat, p_lng: p.lng, p_acc: p.acc });
      if (error) {
        let msg = errText(error);
        if (p.acc > 100 && !/Sinal de GPS/.test(msg)) msg += ' A precisão do GPS está baixa (± ' + Math.round(p.acc) + ' m): ative a "localização precisa" para o navegador ou app e tente de novo.';
        throw new Error(msg);
      }
      await loadAtt(); render(true);
      toast((kind === 'in' ? 'Check-in' : 'Check-out') + ' registrado às ' + fmtHM(data.at) + ' (a ' + fmtDist(data.dist) + ' do hospital).', 'ok', 5000);
    });
  }

  /* ---------- modais ---------- */
  function openCellModal(id) {
    const p = parseSid(id), cur = docOf(id), a = cur ? attOf(id, cur) : null, pend = pendingSwapFor(id);
    const hid = unitHosp(p.unit);
    const docs = S.doctors.filter((d) => d.active).sort((x, y) => (worksAt(y.id, hid) - worksAt(x.id, hid)) || x.name.localeCompare(y.name));
    const opts = (filter) => '<div class="opt' + (!cur ? ' sel' : '') + '" data-act="pickDoc" data-doc=""><div class="grow"><b>Sem escala</b></div></div>' + docs.filter((d) => !filter || d.name.toLowerCase().includes(filter) || (d.crm || '').includes(filter)).map((d) => {
      const other = whereElse(d.id, p.date, p.turn, p.unit);
      const adj = [slotMove(p, -1), slotMove(p, 1)].some((s) => S.units.some((u) => docOf(sid(s.date, s.turn, u.id)) === d.id));
      return '<div class="opt' + (d.id === cur ? ' sel' : '') + '" data-act="pickDoc" data-doc="' + d.id + '"><div class="grow"><b>' + esc(d.name) + '</b>' + (d.crm ? ' <span class="muted small">CRM ' + esc(d.crm) + '</span>' : '') +
        (other ? '<div class="small" style="color:var(--bad)">Já está na ' + esc(unitName(other)) + ' neste turno (vai gerar conflito)</div>' : '') +
        (!worksAt(d.id, hid) ? '<div class="tiny" style="color:var(--warn)">Não está vinculado a este hospital</div>' : '') + (adj && !other ? '<div class="tiny muted">Emenda com turno vizinho (24 h)</div>' : '') + '</div></div>';
    }).join('');
    openModal(turnName(p.turn) + ' · ' + fmtDay(p.date), '<p class="muted small" style="margin-top:-6px">' + esc(unitFull(p.unit)) + ' · ' + turnHours(p.turn) + '</p>' +
      (a && a.check_in ? '<div class="note" style="margin-bottom:10px">' + esc(docHistName(cur)) + ' já fez check-in neste plantão. Trocar o médico agora não apaga esse registro.</div>' : '') +
      (pend ? '<div class="note" style="margin-bottom:10px">Há uma troca em andamento para este plantão. Se você mudar a escala, a autorização dessa troca será recusada.</div>' : '') +
      (docs.length > 8 ? '<input class="input" placeholder="Buscar médico…" data-input="cellFilter" style="margin-bottom:8px">' : '') +
      '<div id="cell-opts">' + opts('') + '</div>');
    S.modal.shiftId = id; S.modal.opts = opts;
  }

  function openSwapModal(shiftId) {
    if (pendingSwapFor(shiftId)) { toast('Já existe uma troca em andamento para este plantão.', 'bad'); return; }
    if (shiftStart(shiftId) <= new Date()) { toast('Este plantão já começou.', 'bad'); return; }
    openModal('Oferecer troca', '');
    S.modal.form = { shift: shiftId, to: null, type: 'repasse', ret: null, note: '' };
    S.modal.refresh = refreshSwapModal;
    refreshSwapModal();
  }
  function refreshSwapModal() {
    const M = S.modal; if (!M || !M.form) return;
    const f = M.form, p = parseSid(f.shift), now = new Date();
    const ta = $('#sw-note'); if (ta) f.note = ta.value;
    const hid = unitHosp(p.unit);
    const colleagues = S.doctors.filter((d) => d.active && d.id !== S.me.id && worksAt(d.id, hid)).sort((a, b) => a.name.localeCompare(b.name));
    const list = colleagues.map((d) => {
      const other = whereElse(d.id, p.date, p.turn, p.unit);
      const why = !d.user_id ? 'Ainda não entrou no app' : other ? 'Já está na ' + unitName(other) + ' neste turno' : '';
      return '<div class="opt' + (f.to === d.id ? ' sel' : '') + (why ? ' dis' : '') + '" data-act="swTo" data-doc="' + d.id + '"><div class="grow"><b>' + esc(d.name) + '</b>' + (why ? '<div class="tiny muted">' + esc(why) + '</div>' : '') + '</div></div>';
    }).join('');
    let ret = '';
    if (f.type === 'permuta' && f.to) {
      const theirs = [...S.shifts.values()].filter((s) => s.doctor_id === f.to && shiftStart(s.id) > now).sort((a, b) => shiftStart(a.id) - shiftStart(b.id)).slice(0, 40);
      ret = '<div class="field"><label class="f">Plantão do colega que você assume</label>' + (theirs.length ? theirs.map((s) => {
        const same = s.date === p.date && s.turn === p.turn, other = whereElse(S.me.id, s.date, s.turn, s.unit_id), pend = pendingSwapFor(s.id);
        const why = same ? 'Mesmo turno do seu plantão' : !worksAt(S.me.id, unitHosp(s.unit_id)) ? 'Você não trabalha neste hospital' : other ? 'Você já está na ' + unitName(other) + ' neste turno' : pend ? 'Troca em andamento' : '';
        return '<div class="opt' + (f.ret === s.id ? ' sel' : '') + (why ? ' dis' : '') + '" data-act="swRet" data-id="' + s.id + '"><div class="grow"><b>' + fmtDay(s.date) + ' · ' + turnName(s.turn) + '</b> <span class="muted small">' + esc(unitFull(s.unit_id)) + '</span>' + (why ? '<div class="tiny muted">' + esc(why) + '</div>' : '') + '</div></div>';
      }).join('') : '<div class="empty">Este colega não tem plantões futuros na escala.</div>') + '</div>';
    }
    setModalBody('<div class="note" style="margin:0 0 12px"><b>Seu plantão:</b> ' + esc(shiftDesc(f.shift)) + '</div>' +
      '<div class="field"><label class="f">Tipo</label><div class="seg"><button data-act="swType" data-type="repasse" class="' + (f.type === 'repasse' ? 'on' : '') + '">Repasse</button><button data-act="swType" data-type="permuta" class="' + (f.type === 'permuta' ? 'on' : '') + '">Permuta</button></div><div class="hint">' + (f.type === 'repasse' ? 'O colega assume seu plantão.' : 'Cada um assume um plantão do outro.') + '</div></div>' +
      '<div class="field"><label class="f">Colega</label>' + (list || '<div class="empty">Nenhum colega trabalha neste hospital.</div>') + '</div>' + ret +
      '<div class="field"><label class="f" for="sw-note">Recado (opcional)</label><textarea class="input" id="sw-note" maxlength="280" placeholder="Ex.: consegue cobrir? Te devo uma.">' + esc(f.note) + '</textarea></div>' +
      '<div class="mf"><button class="btn" data-act="mclose">Cancelar</button><button class="btn primary" data-act="swSend">Enviar pedido</button></div>' +
      '<p class="hint">O colega precisa aceitar e o gestor autorizar. A escala só muda depois da autorização.</p>');
  }

  function openAdjustModal(id, doc) {
    const a = attOf(id, doc) || {};
    openModal('Ajustar presença', '<p class="small" style="margin-top:-6px"><b>' + esc(docHistName(doc)) + '</b><br><span class="muted">' + esc(shiftDesc(id)) + '</span></p>' +
      '<div class="field"><label class="f" for="adj-in">Entrada</label><div class="row" style="flex-wrap:nowrap"><input class="input" type="datetime-local" id="adj-in" value="' + toLocalInput(a.check_in) + '"><button class="btn sm ghost" data-act="adjClear" data-for="adj-in">Limpar</button></div>' + (a.in_dist != null ? '<div class="hint">Registro por GPS a ' + fmtDist(a.in_dist) + ' (precisão ± ' + a.in_acc + ' m)</div>' : '') + '</div>' +
      '<div class="field"><label class="f" for="adj-out">Saída</label><div class="row" style="flex-wrap:nowrap"><input class="input" type="datetime-local" id="adj-out" value="' + toLocalInput(a.check_out) + '"><button class="btn sm ghost" data-act="adjClear" data-for="adj-out">Limpar</button></div>' + (a.out_dist != null ? '<div class="hint">Registro por GPS a ' + fmtDist(a.out_dist) + ' (precisão ± ' + a.out_acc + ' m)</div>' : '') + '</div>' +
      '<p class="hint">O turno vai de ' + fmtDT(shiftStart(id)) + ' a ' + fmtDT(shiftEnd(id)) + '. O ajuste fica marcado como manual e registrado na trilha de auditoria, com o valor anterior e quem alterou.</p>' +
      '<div class="mf"><button class="btn" data-act="mclose">Cancelar</button><button class="btn primary" data-act="adjSave">Salvar ajuste</button></div>');
    S.modal.shiftId = id; S.modal.doc = doc;
  }

  function openDocModal(id) {
    const d = id ? docById(id) : { name: '', email: '', crm: '', phone: '', active: true, is_manager: false };
    const self = id && id === S.me.id;
    openModal(id ? 'Editar médico' : 'Novo médico', '<form data-submit="saveDoc" data-id="' + (id || '') + '" novalidate>' +
      '<div class="field"><label class="f" for="d-name">Nome completo *</label><input class="input" id="d-name" name="name" required maxlength="100" value="' + esc(d.name) + '" autofocus></div>' +
      '<div class="field"><label class="f" for="d-email">E-mail (usado no login) *</label><input class="input" id="d-email" name="email" type="email" required autocapitalize="off" spellcheck="false" value="' + esc(d.email) + '"></div>' +
      '<div class="grid cols2" style="margin-top:12px"><div><label class="f" for="d-crm">CRM</label><input class="input" id="d-crm" name="crm" maxlength="20" value="' + esc(d.crm || '') + '"></div>' +
      '<div><label class="f" for="d-phone">Telefone</label><input class="input" id="d-phone" name="phone" type="tel" maxlength="30" value="' + esc(d.phone || '') + '"></div></div>' +
      '<div class="field" style="margin-top:14px"><label class="check"><input type="checkbox" name="active" ' + (d.active ? 'checked' : '') + (self ? ' disabled' : '') + '> Ativo (pode entrar no app)</label></div>' +
      '<div class="field"><label class="check"><input type="checkbox" name="is_manager" ' + (d.is_manager ? 'checked' : '') + (self ? ' disabled' : '') + '> Gestor (monta a escala e autoriza trocas)</label>' + (self ? '<div class="hint">Você não pode desativar a si mesmo nem tirar o próprio papel de gestor.</div>' : '') + '</div>' +
      '<div class="field" style="margin-top:14px"><label class="f">Hospitais em que trabalha</label>' + S.hospitals.map((h) => '<label class="check" style="margin:6px 0"><input type="checkbox" name="hosp" value="' + h.id + '"' + (id && docHosps(id) && docHosps(id).has(h.id) ? ' checked' : '') + '> ' + esc(h.name) + '</label>').join('') +
        '<div class="hint">Nenhum marcado = trabalha em todos. O plantonista vê só a escala desses hospitais e só troca com colegas que trabalham neles.</div></div>' +
      (id ? '<div class="small muted" style="margin-top:10px">' + (d.user_id ? 'Já entrou no app.' : 'Ainda não entrou no app.') + '</div>' : '') +
      '<div class="mf">' + (id && d.user_id && !self ? '<button type="button" class="btn danger" data-act="docUnlink" data-id="' + id + '" style="margin-right:auto">Desvincular login</button>' : '') +
      '<button type="button" class="btn" data-act="mclose">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>');
  }

  /* ---------- conta e senha ---------- */
  const pwField = (id, label, auto, extra) => '<div class="field"><label class="f" for="' + id + '">' + label + '</label><div class="pwwrap">' +
    '<input class="input" id="' + id + '" type="password" autocomplete="' + auto + '" autocapitalize="off" autocorrect="off" spellcheck="false"' + (extra || '') + '>' +
    '<button type="button" class="pweye" data-act="pwEye" data-for="' + id + '" aria-label="Mostrar senha" title="Mostrar senha">' + ICON.eye + '</button></div></div>';
  const PW_RULES = [['len', 'Pelo menos 8 caracteres'], ['let', 'Pelo menos uma letra'], ['num', 'Pelo menos um número'], ['eq', 'As duas senhas iguais']];
  function pwChecks(a, b) { return { len: a.length >= 8, let: /[A-Za-zÀ-ÿ]/.test(a), num: /\d/.test(a), eq: !!a && a === b }; }
  function pwRulesHtml(a, b) {
    const c = pwChecks(a || '', b || '');
    return PW_RULES.map(([k, t]) => '<li class="' + (c[k] ? 'ok' : '') + '"><span class="tick">' + (c[k] ? '✓' : '•') + '</span>' + t + '</li>').join('');
  }
  function openPwModal(first) {
    openModal(first ? 'Crie sua senha' : (hasPw() ? 'Trocar senha' : 'Criar senha'), '<form data-submit="savePw" novalidate>' +
      (first ? '<p class="small" style="margin-top:-4px">Com uma senha você entra direto, sem esperar o código por e-mail. O código continua valendo se esquecer a senha.</p>' : '') +
      '<div class="note" style="margin:0 0 12px"><b>Requisitos da senha</b><ul class="pwrules" id="pw-rules">' + pwRulesHtml('', '') + '</ul>' +
      '<div class="tiny muted" style="margin-top:6px">Dica: use uma frase fácil de lembrar e não repita a senha de outros sistemas. Toque no olho para ver o que está digitando.</div></div>' +
      '<input type="email" autocomplete="username" value="' + esc((S.session && S.session.user && S.session.user.email) || S.me.email) + '" style="display:none" readonly>' +
      pwField('pw1', 'Nova senha', 'new-password', ' data-input="pwCheck" autofocus') +
      pwField('pw2', 'Repita a nova senha', 'new-password', ' data-input="pwCheck"') +
      '<div class="mf">' + (first ? '<button type="button" class="btn" data-act="pwLater">Agora não</button>' : '<button type="button" class="btn" data-act="mclose">Cancelar</button>') +
      '<button class="btn primary" type="submit">Salvar senha</button></div></form>');
  }
  function openAccount() {
    const u = (S.session && S.session.user) || {};
    openModal('Minha conta', '<p style="margin-top:-4px"><b>' + esc(S.me.name) + '</b><br><span class="muted small">' + esc(u.email || S.me.email) + '</span></p>' +
      '<div class="card" style="box-shadow:none"><h3>Notificações neste aparelho</h3><div id="push-box" class="small" style="margin-top:8px">Verificando…</div></div>' +
      '<div class="card" style="box-shadow:none;margin-top:10px"><h3>Senha</h3><p class="small muted" style="margin:6px 0 10px">' + (hasPw() ? 'Você já tem senha e pode trocá-la quando quiser.' : 'Crie uma senha para entrar sem esperar o código por e-mail.') + '</p><button class="btn sm" data-act="pwOpen">' + (hasPw() ? 'Trocar senha' : 'Criar senha') + '</button></div>' +
      '<div class="mf"><button class="btn danger" data-act="logout">' + ICON.out + ' Sair da conta</button></div>');
    renderPushBox();
  }

  function sessionLost() {
    openModal('Sessão expirada', '<p>Por segurança, sua sessão expirou e a senha não foi salva.</p><p class="small muted">Toque em <b>Entrar de novo</b>, peça o código por e-mail e, logo depois de entrar, crie a senha. Leva menos de um minuto.</p>' +
      '<div class="mf"><button class="btn primary" data-act="logout">Entrar de novo</button></div>');
  }

  /* ---------- notificações push ---------- */
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!CFG.vapidPublicKey;
  function b64uToU8(s) { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
  async function pushState() {
    if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }
  async function refreshPushState(atStart) {
    try {
      S.pushSt = await pushState();
      // mantém o vínculo do aparelho com o médico logado
      if (atStart && S.pushSt === 'on') {
        const reg = await navigator.serviceWorker.getRegistration(), sub = reg && await reg.pushManager.getSubscription();
        if (sub) { const j = sub.toJSON(); await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent }); }
      }
    } catch (e) { S.pushSt = 'unsupported'; }
    if (atStart && (S.tab === 'agora' || S.tab === 'meu')) render();
  }
  async function enablePush() {
    if (!pushSupported()) throw new Error(isIOS() && !isStandalone() ? 'No iPhone, instale o app na tela inicial (Compartilhar > Adicionar à Tela de Início) e ative as notificações por lá.' : 'Este navegador não oferece notificações.');
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') throw new Error('As notificações não foram permitidas. Libere nas configurações do celular (Ajustes > Notificações) e tente de novo.');
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(CFG.vapidPublicKey) });
    const j = sub.toJSON();
    await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent });
  }
  async function disablePush(keepBrowserSub) {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration(), sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
    if (!sub) return;
    try { await rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); } catch (e) { /* */ }
    if (!keepBrowserSub) await sub.unsubscribe();
  }
  async function renderPushBox() {
    const box = $('#push-box'); if (!box) return;
    const st = await pushState().catch(() => 'unsupported'); S.pushSt = st;
    const html = {
      on: '<div class="row between"><span>' + chip('Ativadas', 'ok') + '</span><span class="row" style="gap:6px"><button class="btn sm" data-act="pushTest">Enviar teste</button><button class="btn sm" data-act="pushOff">Desativar</button></span></div><p class="hint">Avisos de trocas, lembretes de check-in e check-out' + (isMgr() ? ' e alertas de UTI sem check-in' : '') + '.</p>',
      off: '<p class="muted" style="margin:0 0 8px">Desativadas neste aparelho.</p><button class="btn primary sm" data-act="pushOn">Ativar notificações</button>',
      denied: '<p style="margin:0">' + chip('Bloqueadas', 'bad') + '</p><p class="hint">Libere nas configurações: no iPhone, Ajustes > Notificações > Plantão UTI; no Android, toque no cadeado ao lado do endereço > Permissões > Notificações.</p>',
      'ios-install': '<p style="margin:0">No iPhone, as notificações só funcionam com o app instalado: no Safari, toque em <b>Compartilhar</b> > <b>Adicionar à Tela de Início</b> e abra o app pelo ícone. Precisa do iOS 16.4 ou mais novo.</p>',
      unsupported: '<p class="muted" style="margin:0">Este navegador não oferece notificações. No Android use o Chrome; no iPhone, o app instalado na tela inicial.</p>'
    }[st];
    box.innerHTML = html;
  }
  function pushBanner() {
    const st = S.pushSt;
    if (st !== 'off' && st !== 'ios-install') return '';
    let t = 0; try { t = +localStorage.getItem('plantao-push-dismiss') || 0; } catch (e) { /* */ }
    if (Date.now() - t < 14 * DAY) return '';
    return '<div class="card no-print" style="margin-bottom:12px;border-color:var(--brand)"><div class="row between"><div class="small" style="flex:1;min-width:200px"><b>Receba avisos no celular</b><br><span class="muted">' +
      (st === 'ios-install' ? 'No iPhone: Compartilhar > Adicionar à Tela de Início, depois abra o app pelo ícone e ative aqui.' : 'Pedidos de troca, lembretes de check-in e check-out' + (S.role === 'gestor' ? ' e UTIs sem check-in' : '') + '.') +
      '</span></div><div class="row" style="gap:6px">' + (st === 'off' ? '<button class="btn primary sm" data-act="pushOn">Ativar</button>' : '') + '<button class="btn ghost sm" data-act="pushDismiss">Agora não</button></div></div></div>';
  }

  /* ---------- PDF da escala (mensal por hospital) ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
      const s = document.createElement('script'); s.src = src; s.dataset.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('Não foi possível carregar o gerador de PDF. Verifique a internet.'));
      document.head.appendChild(s);
    });
  }
  function openPdfModal() {
    const m = S.week, f = ymd(new Date(m.getFullYear(), m.getMonth(), 1)), t = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 0));
    const sel = new Set(selectedHospitals().map((h) => h.id));
    openModal('Escala em PDF', '<div class="grid cols2"><div><label class="f" for="pdf-from">De</label><input class="input" type="date" id="pdf-from" value="' + f + '"></div>' +
      '<div><label class="f" for="pdf-to">Até</label><input class="input" type="date" id="pdf-to" value="' + t + '"></div></div>' +
      '<div class="field" style="margin-top:12px"><label class="f">Hospitais</label>' + visibleHospitals().map((h) => '<label class="check" style="margin:6px 0"><input type="checkbox" name="pdf-h" value="' + h.id + '"' + (sel.has(h.id) ? ' checked' : '') + '> ' + esc(h.name) + '</label>').join('') + '</div>' +
      '<p class="hint">Uma página por hospital e por mês (A4 deitado), com o médico de cada turno em cada UTI. Dias fora do período ficam em cinza.</p>' +
      '<div class="mf"><button class="btn" data-act="mclose">Cancelar</button><button class="btn primary" data-act="pdfGo">Gerar PDF</button></div>');
  }
  function fitText(pdf, t, w) {
    if (pdf.getTextWidth(t) <= w) return t;
    while (t.length > 1 && pdf.getTextWidth(t + '…') > w) t = t.slice(0, -1);
    return t + '…';
  }
  async function generatePdf(from, to, hospIds) {
    await ensureRange(from, to);
    await loadScript('vendor/jspdf.umd.min.js');
    const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = 297, H = 210, M = 10, MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const SEM = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
    const now = new Date(), gen = 'Gerado em ' + fmtDMY(now) + ' às ' + fmtHM(now) + ' · Plantão UTI';
    const months = []; const d0 = parseYmd(from); d0.setDate(1); const dEnd = parseYmd(to);
    for (const d = new Date(d0); d <= dEnd; d.setMonth(d.getMonth() + 1)) months.push(new Date(d));
    let firstPage = true;
    for (const hid of hospIds) {
      const h = hospById(hid), us = S.units.filter((u) => u.hospital_id === hid);
      if (!h || !us.length) continue;
      for (const m0 of months) {
        if (!firstPage) pdf.addPage(); firstPage = false;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15); pdf.setTextColor(11, 110, 116);
        pdf.text('Escala de plantões · ' + h.name, M, 13);
        pdf.setFontSize(13); pdf.setTextColor(21, 35, 37); pdf.text(MES[m0.getMonth()] + ' de ' + m0.getFullYear(), W - M, 13, { align: 'right' });
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(91, 109, 112);
        pdf.text('UTIs: ' + us.map((u) => u.name).join(', ') + '   ·   D = diurno 7h–19h   ·   N = noturno 19h–7h   ·   Período: ' + fmtDMY(from) + ' a ' + fmtDMY(to), M, 19);
        const gStart = startOfWeek(m0), mLast = new Date(m0.getFullYear(), m0.getMonth() + 1, 0);
        const weeks = Math.ceil((Math.round((mLast - gStart) / DAY) + 1) / 7);
        const top = 23, headH = 6, bottom = H - 9, colW = (W - 2 * M) / 7, rowH = (bottom - top - headH) / weeks;
        SEM.forEach((n, i) => {
          pdf.setFillColor(11, 110, 116); pdf.rect(M + i * colW, top, colW, headH, 'F');
          pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.text(n, M + i * colW + colW / 2, top + 4.1, { align: 'center' });
        });
        for (let w = 0; w < weeks; w++) for (let i = 0; i < 7; i++) {
          const day = addDays(gStart, w * 7 + i), ds = ymd(day), x = M + i * colW, y = top + headH + w * rowH;
          const inMonth = day.getMonth() === m0.getMonth(), inRange = ds >= from && ds <= to;
          if (!inMonth || !inRange) { pdf.setFillColor(238, 241, 241); pdf.rect(x, y, colW, rowH, 'F'); }
          else if (i >= 5) { pdf.setFillColor(247, 250, 250); pdf.rect(x, y, colW, rowH, 'F'); }
          pdf.setDrawColor(200, 210, 210); pdf.setLineWidth(0.2); pdf.rect(x, y, colW, rowH);
          if (!inMonth) continue;
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
          if (inRange) pdf.setTextColor(21, 35, 37); else pdf.setTextColor(160, 160, 160);
          pdf.text(String(day.getDate()), x + 1.5, y + 3.7);
          if (!inRange) continue;
          const lines = [];
          us.forEach((u) => { if (us.length > 1) lines.push(['u', u.name]); ['D', 'N'].forEach((t) => { const dc = docOf(sid(ds, t, u.id)); lines.push([t, dc ? shortName(docScaleName(dc)) : '—']); }); });
          const avail = rowH - 5, lh = Math.min(3.3, avail / lines.length), fs = Math.max(4.5, Math.min(7.5, lh * 2.25));
          let yy = y + 5 + lh * 0.75;
          lines.forEach(([k, txt]) => {
            if (k === 'u') { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(fs - 0.6); pdf.setTextColor(11, 110, 116); pdf.text(fitText(pdf, txt, colW - 3), x + 1.5, yy); }
            else {
              pdf.setFont('helvetica', 'bold'); pdf.setFontSize(fs); pdf.setTextColor(91, 109, 112); pdf.text(k, x + 1.5, yy);
              pdf.setFont('helvetica', 'normal'); if (txt === '—') pdf.setTextColor(170, 170, 170); else pdf.setTextColor(21, 35, 37);
              pdf.text(fitText(pdf, txt, colW - 6), x + 4.6, yy);
            }
            yy += lh;
          });
        }
      }
    }
    if (firstPage) throw new Error('Nenhuma UTI nos hospitais escolhidos.');
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(120, 120, 120);
      pdf.text(gen, M, H - 4); pdf.text('Página ' + i + ' de ' + n, W - M, H - 4, { align: 'right' });
    }
    pdf.save('escala_' + from + '_a_' + to + '.pdf');
  }

  /* ---------- submits ---------- */
  async function sendOtp(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    S.login.resendAt = Date.now() + 60000;
  }
  const SUBMIT = {
    loginPw: async (form) => {
      const email = form.querySelector('#lg-email').value.trim().toLowerCase(), password = form.querySelector('#lg-pw').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Digite um e-mail válido.', 'bad'); return; }
      S.login.email = email;
      if (!password) { toast('Digite sua senha ou use "Receber código por e-mail".', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Entrando…', async () => {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      });
    },
    savePw: async (form) => {
      const a = form.querySelector('#pw1').value, b = form.querySelector('#pw2').value, c = pwChecks(a, b);
      if (!c.len) { toast('A senha precisa ter pelo menos 8 caracteres.', 'bad'); return; }
      if (!c.let || !c.num) { toast('A senha precisa ter pelo menos uma letra e um número.', 'bad'); return; }
      if (!c.eq) { toast('As duas senhas não são iguais.', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Salvando…', async () => {
        // garante uma sessão válida (o iPhone pode suspender a renovação automática em segundo plano)
        let { data: sd } = await sb.auth.getSession();
        if (!sd || !sd.session) { const r = await sb.auth.refreshSession(); sd = r.data; }
        if (!sd || !sd.session) { sessionLost(); return; }
        const { data, error } = await sb.auth.updateUser({ password: a, data: { has_password: true } });
        if (error) { if (/session/i.test(error.message || '')) { sessionLost(); return; } throw error; }
        if (data && data.user && S.session) S.session.user = data.user;
        closeModal(); toast('Senha salva. Nos próximos acessos, entre com e-mail e senha.', 'ok', 5000);
      });
    },
    verifyCode: async (form) => {
      const token = form.querySelector('#lg-code').value.replace(/\D/g, '');
      if (token.length < 6 || token.length > 10) { toast('O código tem de 6 a 10 dígitos.', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Entrando…', async () => {
        const { error } = await sb.auth.verifyOtp({ email: S.login.email, token, type: 'email' });
        if (error) throw error;
      });
    },
    saveDoc: async (form) => {
      const id = form.dataset.id, g = (n) => form.querySelector('[name=' + n + ']');
      const row = { name: g('name').value.trim(), email: g('email').value.trim().toLowerCase(), crm: g('crm').value.trim() || null, phone: g('phone').value.trim() || null };
      if (!row.name) { toast('Informe o nome.', 'bad'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) { toast('Informe um e-mail válido.', 'bad'); return; }
      if (!(id && id === S.me.id)) { row.active = g('active').checked; row.is_manager = g('is_manager').checked; }
      const hosps = [...form.querySelectorAll('[name=hosp]:checked')].map((i) => i.value);
      const old = id ? docById(id) : null;
      if (old && old.user_id && old.email !== row.email && !(await confirmBox('E-mail alterado', 'Este médico já entrou no app com <b>' + esc(old.email) + '</b>. A conta atual continua vinculada. Para ele passar a entrar com o novo e-mail, use também "Desvincular login". Salvar mesmo assim?', 'Salvar'))) return;
      await busy(form.querySelector('button[type=submit]'), 'Salvando…', async () => {
        let docId = id;
        if (id) { const { error } = await sb.from('doctors').update(row).eq('id', id); if (error) throw error; }
        else { const { data, error } = await sb.from('doctors').insert(row).select('id').single(); if (error) throw error; docId = data.id; }
        const cur = [...(docHosps(docId) || [])].sort().join(','), want = hosps.slice().sort().join(',');
        if (cur !== want) {
          const { error: e1 } = await sb.from('doctor_hospitals').delete().eq('doctor_id', docId); if (e1) throw e1;
          if (hosps.length) { const { error: e2 } = await sb.from('doctor_hospitals').insert(hosps.map((h) => ({ doctor_id: docId, hospital_id: h }))); if (e2) throw e2; }
        }
        await loadStatic(); closeModal(); render(true); toast(id ? 'Cadastro atualizado.' : 'Médico cadastrado. Envie a ele o link do app.', 'ok');
      });
    },
    saveHosp: async (form) => {
      const name = form.querySelector('[name=name]').value.trim(), c = parseCoords(form.querySelector('[name=coords]').value), r = +form.querySelector('[name=radius]').value;
      if (!name) { toast('Informe o nome do hospital.', 'bad'); return; }
      if (c === undefined) { toast('Coordenadas inválidas. Use o formato "-23.1857, -46.8978".', 'bad'); return; }
      if (!(r >= 50 && r <= 2000)) { toast('O raio deve ficar entre 50 e 2000 m.', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Salvando…', async () => {
        const { error } = await sb.from('hospitals').update({ name, lat: c ? c.lat : null, lng: c ? c.lng : null, radius_m: Math.round(r) }).eq('id', form.dataset.id);
        if (error) throw error; await loadStatic(); render(true); toast('Hospital salvo.', 'ok');
      });
    },
    saveUnit: async (form) => {
      const name = form.querySelector('[name=name]').value.trim(), hospital_id = form.querySelector('[name=hospital]').value;
      if (!name) { toast('Informe o nome da UTI.', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Salvando…', async () => {
        const { error } = await sb.from('units').update({ name, hospital_id }).eq('id', form.dataset.id);
        if (error) throw error; await loadStatic(); render(true); toast('UTI salva.', 'ok');
      });
    },
    saveSettings: async (form) => {
      const tol = +form.querySelector('[name=tol]').value, early = +form.querySelector('[name=early]').value;
      if (!(tol >= 0 && tol <= 60) || !(early >= 0 && early <= 180)) { toast('Tolerância: 0 a 60 min. Abertura: 0 a 180 min.', 'bad'); return; }
      await busy(form.querySelector('button[type=submit]'), 'Salvando…', async () => {
        const { error } = await sb.from('settings').update({ tolerance_min: Math.round(tol), early_min: Math.round(early) }).eq('id', 1);
        if (error) throw error; await loadStatic(); render(true); toast('Pontualidade salva.', 'ok');
      });
    }
  };
  const CHANGE = {
    presFilter: () => {
      let from = $('#pf-from').value, to = $('#pf-to').value; const doctor = $('#pf-doc').value;
      if (!from || !to) return;
      if (from > to) { const t = from; from = to; to = t; }
      if (parseYmd(to) - parseYmd(from) > 92 * DAY) { from = ymd(addDays(parseYmd(to), -92)); toast('O período máximo é de 3 meses. A data inicial foi ajustada.'); }
      S.pres = { from, to, doctor };
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      render(true);
    }
  };
  const INPUT = {
    pwCheck: () => { const ul = $('#pw-rules'); if (ul) ul.innerHTML = pwRulesHtml($('#pw1').value, $('#pw2').value); },
    cellFilter: (el) => { const box = $('#cell-opts'); if (box && S.modal && S.modal.opts) box.innerHTML = S.modal.opts(el.value.trim().toLowerCase()); }
  };

  /* ---------- CSV ---------- */
  function exportCsv() {
    const rows = presenceRows(), P = S.pres;
    const q = (v) => { v = v == null ? '' : String(v); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const dt = (iso) => (iso ? fmtDMY(iso) + ' ' + fmtHM(iso) : '');
    const head = ['Data', 'Dia', 'Turno', 'UTI', 'Hospital', 'Médico', 'CRM', 'Entrada', 'Saída', 'Horas', 'Atraso (min)', 'Situação', 'Distância entrada (m)', 'Distância saída (m)', 'Precisão GPS entrada (m)', 'Ajuste manual', 'Fora da escala atual'];
    const lines = [head.map(q).join(';')];
    rows.slice().reverse().forEach((r) => {
      const p = parseSid(r.id), a = r.a || {}, d = docById(r.doc) || {}, h = hospOfUnit(p.unit) || {};
      lines.push([fmtDMY(p.date), DOW[parseYmd(p.date).getDay()], turnName(p.turn), unitName(p.unit), h.name || '', docHistName(r.doc), d.crm || '', dt(a.check_in), dt(a.check_out), r.hoursMs ? hoursDec(r.hoursMs) : '', r.lateMin || '', r.tags.map((t) => t[0]).join(' / '), a.in_dist, a.out_dist, a.in_acc, a.manual ? 'sim' : '', r.outside ? 'sim' : ''].map(q).join(';'));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'presenca_' + P.from + '_a_' + P.to + '.csv';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('CSV exportado (' + rows.length + ' linhas).', 'ok');
  }

  /* ---------- delegação de eventos ---------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const fn = A[el.dataset.act]; if (!fn) return;
    if (el.tagName !== 'INPUT') e.preventDefault();
    try { const r = fn(el, e); if (r && r.catch) r.catch((err) => toast(errText(err), 'bad')); } catch (err) { console.error(err); toast(errText(err), 'bad'); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-submit]'); if (!f) return;
    e.preventDefault();
    const fn = SUBMIT[f.dataset.submit]; if (fn) fn(f).catch((err) => toast(errText(err), 'bad'));
  });
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el); });
  document.addEventListener('input', (e) => { const el = e.target.closest('[data-input]'); if (el && INPUT[el.dataset.input]) INPUT[el.dataset.input](el); });

  /* ================================== boot ================================== */
  window.__plantao = { S, render, slotAt, shiftStart, attStatus, classify, parseCoords }; // para depuração
  boot().catch((e) => showFatal(errText(e), true));
})();
