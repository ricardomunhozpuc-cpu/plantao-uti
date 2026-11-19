// Edge Function "push": envia notificações Web Push do Plantão UTI.
// Chamada só pelo banco (cabeçalho x-cron-token). Corpos aceitos:
//   {"event":"test","doctor_id":"..."}            teste para o próprio usuário
//   {"event":"swap","id":"...","status":"..."}     avisos de troca e anúncio (gatilho em swaps)
//   {"job":"tick"}                                 lembretes de check-in/out e UTI descoberta (pg_cron, 5 min)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const MIN = 60000, HOUR = 3600000;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function tzOffsetMin(tz: string, at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
const localYmd = (tz: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function shiftStart(tz: string, id: string): Date {
  const [date, turn] = id.split("_");
  const g = new Date(`${date}T${turn === "D" ? "07" : "19"}:00:00Z`);
  return new Date(g.getTime() - tzOffsetMin(tz, g) * MIN);
}
const hm = (tz: string, d: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
const dayLabel = (ymd: string) => { const d = new Date(ymd + "T12:00:00Z"); return `${DOW[d.getUTCDay()]} ${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`; };
const short = (n: string) => { const p = String(n || "").replace(/^(dr|dra)\.?\s+/i, "").trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1]}` : p[0] || ""; };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: ok } = await sb.rpc("check_cron_token", { p_token: req.headers.get("x-cron-token") || "" });
  if (!ok) return json({ error: "não autorizado" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const { data: cfg, error: ce } = await sb.rpc("get_push_config");
    if (ce || !cfg) throw ce || new Error("push_config ausente");
    const vapid = { subject: cfg.subject, publicKey: cfg.public_key, privateKey: cfg.private_key };
    const { data: st } = await sb.from("settings").select("*").eq("id", 1).single();
    const tz: string = st.tz;
    const [{ data: doctors }, { data: units }, { data: hospitals }] = await Promise.all([
      sb.from("doctors").select("id,name,is_manager,active"), sb.from("units").select("*"), sb.from("hospitals").select("*"),
    ]);
    const doc = new Map((doctors || []).map((d: any) => [d.id, d]));
    const unit = new Map((units || []).map((u: any) => [u.id, u]));
    const hosp = new Map((hospitals || []).map((h: any) => [h.id, h]));
    const managers = (doctors || []).filter((d: any) => d.is_manager && d.active).map((d: any) => d.id);
    const where = (unitId: string) => { const u: any = unit.get(unitId) || {}; const h: any = hosp.get(u.hospital_id) || {}; return `${u.name || unitId} · ${h.name || ""}`; };
    const desc = (id: string) => { const [date, turn, u] = id.split("_"); return `${dayLabel(date)} · ${turn === "D" ? "Diurno" : "Noturno"} · ${where(u)}`; };

    let sent = 0, gone = 0;
    async function send(ids: string[], payload: Record<string, unknown>) {
      const uniq = [...new Set(ids.filter(Boolean))];
      if (!uniq.length) return;
      const { data: subs } = await sb.from("push_subscriptions").select("*").in("doctor_id", uniq);
      for (const s of subs || []) {
        try {
          const det = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload), { vapidDetails: vapid, TTL: 6 * 3600, urgency: "high" });
          const res = await fetch(det.endpoint, { method: det.method, headers: det.headers as Record<string, string>, body: det.body });
          if (res.status === 404 || res.status === 410) { await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint); gone++; }
          else if (res.ok) sent++;
          else console.warn("push falhou", res.status, await res.text().catch(() => ""));
        } catch (e) { console.warn("push erro", e); }
      }
    }
    const claim = async (key: string) => { const { data } = await sb.rpc("claim_notification", { p_key: key }); return !!data; };

    if (body.event === "test") {
      await send([body.doctor_id], { title: "Notificações ativadas", body: "Você vai receber os avisos do Plantão UTI neste aparelho.", url: "./", tag: "teste" });
    } else if (body.event === "swap") {
      const { data: w } = await sb.from("swaps").select("*").eq("id", body.id).single();
      if (w) {
        const from: any = doc.get(w.from_doctor) || {}, to: any = doc.get(w.to_doctor) || {};
        const what = desc(w.shift_id) + (w.return_shift_id ? ` ⇄ ${desc(w.return_shift_id)}` : "");
        const url = "./?tab=trocas", tag = `troca-${w.id}`;
        const mgrs = managers.filter((m: string) => m !== w.from_doctor && m !== w.to_doctor);
        const started = shiftStart(tz, w.shift_id).getTime() <= Date.now();
        if (w.status === "aberta") {
          // anúncio: avisa colegas elegíveis (trabalham no hospital e estão livres no turno) e os gestores
          const [date, turn, uid] = w.shift_id.split("_");
          const hid = (unit.get(uid) as any || {}).hospital_id;
          const [{ data: links }, { data: same }] = await Promise.all([
            sb.from("doctor_hospitals").select("*"),
            sb.from("shifts").select("doctor_id,unit_id").eq("date", date).eq("turn", turn),
          ]);
          const L = new Map<string, Set<string>>();
          (links || []).forEach((l: any) => { if (!L.has(l.doctor_id)) L.set(l.doctor_id, new Set()); L.get(l.doctor_id)!.add(l.hospital_id); });
          const busy = new Set((same || []).filter((x: any) => x.unit_id !== uid).map((x: any) => x.doctor_id));
          const elig = (doctors || []).filter((d: any) => d.active && d.id !== w.from_doctor && !managers.includes(d.id)
            && (!L.has(d.id) || L.get(d.id)!.has(hid)) && !busy.has(d.id)).map((d: any) => d.id);
          await send(elig, { title: "Plantão disponível", body: `${short(from.name)} anunciou: ${what}. Toque para assumir.`, url, tag });
          await send(mgrs, { title: "Plantão anunciado", body: `${short(from.name)} ofereceu para a equipe: ${what}`, url, tag: `${tag}-g` });
        } else if (w.status === "colega") {
          await send([w.to_doctor], { title: `${short(from.name)} pediu uma troca`, body: what, url, tag });
          await send(mgrs, { title: "Nova proposta de troca", body: `${short(from.name)} → ${short(to.name)} (aguardando ${short(to.name)} aceitar): ${what}`, url, tag: `${tag}-g` });
        } else if (w.status === "gestor") {
          const took = body.old_status === "aberta";
          await send(mgrs, { title: "Troca aguardando autorização", body: took ? `${short(to.name)} assumiu o plantão anunciado por ${short(from.name)}: ${what}` : `${short(from.name)} → ${short(to.name)}: ${what}`, url, tag: `${tag}-g` });
          await send([w.from_doctor], { title: took ? `${short(to.name)} quer assumir seu plantão` : `${short(to.name)} aceitou sua troca`, body: `Aguardando autorização do gestor. ${what}`, url, tag });
        } else if (w.status === "recusada") await send([w.from_doctor], { title: `${short(to.name)} recusou a troca`, body: what, url, tag });
        else if (w.status === "aprovada") await send([w.from_doctor, w.to_doctor], { title: "Troca autorizada", body: `A escala foi atualizada: ${what}`, url, tag });
        else if (w.status === "negada") await send([w.from_doctor, w.to_doctor], { title: "Troca não autorizada", body: what, url, tag });
        else if (w.status === "cancelada" && body.old_status && !started) {
          if (w.to_doctor) await send([w.to_doctor], { title: `${short(from.name)} cancelou o pedido de troca`, body: what, url, tag });
          await send(mgrs, { title: body.old_status === "aberta" ? "Anúncio de plantão cancelado" : "Pedido de troca cancelado", body: `${short(from.name)}: ${what}`, url, tag: `${tag}-g` });
        }
      }
    } else if (body.job === "tick") {
      const now = new Date(), today = localYmd(tz, now), early = st.early_min * MIN, tol = st.tolerance_min * MIN;
      const { data: shifts } = await sb.from("shifts").select("*").gte("date", addDays(today, -1)).lte("date", today).not("doctor_id", "is", null);
      const ids = (shifts || []).map((s: any) => s.id);
      const { data: att } = ids.length ? await sb.from("attendance").select("*").in("shift_id", ids) : { data: [] };
      const A = new Map((att || []).map((a: any) => [`${a.shift_id}|${a.doctor_id}`, a]));
      for (const s of shifts || []) {
        const d: any = doc.get(s.doctor_id); if (!d || !d.active) continue;
        const t0 = shiftStart(tz, s.id).getTime(), t1 = t0 + 12 * HOUR, n = now.getTime();
        const a: any = A.get(`${s.id}|${s.doctor_id}`) || {};
        const k = `${s.id}|${s.doctor_id}`;
        if (!a.check_in && n >= t0 - early && n < t0 && await claim(`open|${k}`)) {
          await send([s.doctor_id], { title: "Check-in liberado", body: `Seu plantão começa às ${hm(tz, new Date(t0))}: ${where(s.unit_id)}`, url: "./?tab=meu", tag: `in-${s.id}` });
        }
        if (!a.check_in && n >= t0 + tol && n < t1) {
          if (await claim(`late|${k}`)) await send([s.doctor_id], { title: "Você ainda não fez check-in", body: `Plantão das ${hm(tz, new Date(t0))}: ${where(s.unit_id)}. Registre a entrada no app.`, url: "./?tab=meu", tag: `in-${s.id}` });
          if (await claim(`uncov|${s.id}`)) await send(managers.filter((m: string) => m !== s.doctor_id), { title: "UTI sem check-in", body: `${where(s.unit_id)}: ${short(d.name)} não registrou entrada no plantão das ${hm(tz, new Date(t0))}.`, url: "./?tab=agora", tag: `uncov-${s.id}` });
        }
        if (a.check_in && !a.check_out && n >= t1 && n < t1 + 6 * HOUR && await claim(`out|${k}`)) {
          await send([s.doctor_id], { title: "Registre seu check-out", body: `O plantão terminou às ${hm(tz, new Date(t1))}: ${where(s.unit_id)}.`, url: "./?tab=meu", tag: `out-${s.id}` });
        }
      }
    }
    return json({ ok: true, sent, gone });
  } catch (e) {
    console.error("push erro", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
