// Núcleo do relatório: classifica os plantões e monta a planilha (sem acesso a rede).
import ExcelJS from "npm:exceljs@4.4.0";

export type Row = Record<string, unknown>;
export interface Data {
  settings: { tolerance_min: number; tz: string };
  hospitals: Row[]; units: Row[]; doctors: Row[]; shifts: Row[]; attendance: Row[];
}
const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const HOUR = 3600000, MIN = 60000;

// Deslocamento do fuso (minutos) num instante, ex.: -180 para America/Sao_Paulo
export function tzOffsetMin(tz: string, at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
// Data local (AAAA-MM-DD) de um instante no fuso
export function localYmd(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// Semana anterior completa (segunda a domingo) em relação à data local de "at"
export function previousWeek(tz: string, at: Date): { from: string; to: string } {
  const today = localYmd(tz, at);
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const thisMonday = addDays(today, -((dow + 6) % 7));
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}
export function shiftStart(tz: string, id: string): Date {
  const [date, turn] = id.split("_");
  const guess = new Date(`${date}T${turn === "D" ? "07" : "19"}:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMin(tz, guess) * MIN);
}
// Instante -> Date cujo horário UTC é a hora local (o Excel não tem fuso)
const asLocal = (tz: string, iso: string | null | undefined) => {
  if (!iso) return null; const d = new Date(iso); return new Date(d.getTime() + tzOffsetMin(tz, d) * MIN);
};

export interface Line {
  shift_id: string; date: string; turn: string; hospital: string; unit: string; hSort: number; uSort: number;
  doctor: string; crm: string; check_in: string | null; check_out: string | null;
  hours: number | null; lateMin: number | null; tags: string[]; in_dist: number | null; out_dist: number | null;
  in_acc: number | null; manual: boolean; outside: boolean;
}

export function buildLines(d: Data, from: string, to: string, now: Date): Line[] {
  const tz = d.settings.tz, tol = d.settings.tolerance_min * MIN;
  const doc = new Map(d.doctors.map((x) => [x.id as string, x]));
  const unit = new Map(d.units.map((x) => [x.id as string, x]));
  const hosp = new Map(d.hospitals.map((x) => [x.id as string, x]));
  const att = new Map(d.attendance.map((a) => [`${a.shift_id}|${a.doctor_id}`, a]));
  const pairs: { id: string; doc: string; outside: boolean }[] = []; const seen = new Set<string>();
  for (const s of d.shifts) {
    const date = s.date as string;
    if (!s.doctor_id || date < from || date > to) continue;
    if (shiftStart(tz, s.id as string) > now) continue;
    seen.add(`${s.id}|${s.doctor_id}`); pairs.push({ id: s.id as string, doc: s.doctor_id as string, outside: false });
  }
  for (const a of d.attendance) {
    const k = `${a.shift_id}|${a.doctor_id}`; const date = a.shift_date as string;
    if (seen.has(k) || date < from || date > to) continue;
    pairs.push({ id: a.shift_id as string, doc: a.doctor_id as string, outside: true });
  }
  const lines = pairs.map(({ id, doc: did, outside }) => {
    const [date, turn, uid] = id.split("_");
    const u = unit.get(uid) || {}; const h = hosp.get(u.hospital_id as string) || {}; const dr = doc.get(did) || {};
    const a = att.get(`${id}|${did}`) || {};
    const st = shiftStart(tz, id).getTime(), en = st + 12 * HOUR;
    const tags: string[] = []; let lateMin: number | null = null, hours: number | null = null;
    const ci = a.check_in ? new Date(a.check_in as string).getTime() : null;
    const co = a.check_out ? new Date(a.check_out as string).getTime() : null;
    if (!ci) tags.push(now.getTime() < st + tol ? "Aguardando" : "Sem check-in");
    else {
      if (ci - st > tol) { lateMin = Math.round((ci - st) / MIN); tags.push(`Atraso ${lateMin} min`); } else tags.push("Pontual");
      if (co) { hours = Math.round((co - ci) / HOUR * 100) / 100; if (co < en - tol) tags.push("Saída antecipada"); }
      else tags.push(now.getTime() > en ? "Sem check-out" : "Em andamento");
    }
    return {
      shift_id: id, date, turn, hospital: (h.name as string) || "", unit: (u.name as string) || uid,
      hSort: Number(h.sort ?? 0), uSort: Number(u.sort ?? 0),
      doctor: (dr.name as string) ? (dr.name as string) + (dr.active === false ? " (inativo)" : "") : "Médico removido",
      crm: (dr.crm as string) || "", check_in: (a.check_in as string) || null, check_out: (a.check_out as string) || null,
      hours, lateMin, tags, in_dist: (a.in_dist as number) ?? null, out_dist: (a.out_dist as number) ?? null,
      in_acc: (a.in_acc as number) ?? null, manual: !!a.manual, outside,
    } as Line;
  });
  lines.sort((x, y) => x.date.localeCompare(y.date) || x.turn.localeCompare(y.turn) || x.hSort - y.hSort || x.uSort - y.uSort);
  return lines;
}

export interface Sum { doctor: string; crm: string; n: number; ok: number; late: number; lateMin: number; noin: number; noout: number; early: number; manual: number; hours: number }
export function summarize(lines: Line[]): Sum[] {
  const m = new Map<string, Sum>();
  for (const l of lines) {
    const s = m.get(l.doctor) || { doctor: l.doctor, crm: l.crm, n: 0, ok: 0, late: 0, lateMin: 0, noin: 0, noout: 0, early: 0, manual: 0, hours: 0 };
    s.n++; s.hours += l.hours || 0; s.lateMin += l.lateMin || 0; if (l.manual) s.manual++;
    for (const t of l.tags) {
      if (t === "Pontual") s.ok++; else if (t.startsWith("Atraso")) s.late++; else if (t === "Sem check-in") s.noin++;
      else if (t === "Sem check-out") s.noout++; else if (t === "Saída antecipada") s.early++;
    }
    m.set(l.doctor, s);
  }
  return [...m.values()].sort((a, b) => a.doctor.localeCompare(b.doctor, "pt-BR"));
}

const fmtBR = (ymd: string) => ymd.split("-").reverse().join("/");

export async function buildWorkbook(d: Data, from: string, to: string, now: Date, lines: Line[], sums: Sum[]): Promise<Uint8Array> {
  const tz = d.settings.tz;
  const wb = new ExcelJS.Workbook(); wb.creator = "Opus Scala"; wb.created = now;
  const head = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6E74" } }, alignment: { vertical: "middle", wrapText: true } } as const;
  const fill = (argb: string) => ({ type: "pattern", pattern: "solid", fgColor: { argb } }) as ExcelJS.Fill;

  // Aba 1: Registros
  const ws = wb.addWorksheet("Registros", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Data", key: "date", width: 11, style: { numFmt: "dd/mm/yyyy" } },
    { header: "Dia", key: "dow", width: 6 },
    { header: "Turno", key: "turn", width: 9 },
    { header: "Hospital", key: "hospital", width: 26 },
    { header: "UTI", key: "unit", width: 20 },
    { header: "Médico", key: "doctor", width: 28 },
    { header: "CRM", key: "crm", width: 10 },
    { header: "Entrada", key: "in", width: 16, style: { numFmt: "dd/mm/yyyy hh:mm" } },
    { header: "Saída", key: "out", width: 16, style: { numFmt: "dd/mm/yyyy hh:mm" } },
    { header: "Horas", key: "hours", width: 8, style: { numFmt: "0.00" } },
    { header: "Atraso (min)", key: "late", width: 10 },
    { header: "Situação", key: "sit", width: 30 },
    { header: "Dist. entrada (m)", key: "ind", width: 11 },
    { header: "Dist. saída (m)", key: "outd", width: 11 },
    { header: "Precisão GPS entrada (m)", key: "acc", width: 12 },
    { header: "Ajuste manual", key: "man", width: 9 },
    { header: "Fora da escala atual", key: "outside", width: 10 },
  ];
  for (const l of lines) {
    const r = ws.addRow({
      date: new Date(l.date + "T00:00:00Z"), dow: DOW[new Date(l.date + "T12:00:00Z").getUTCDay()],
      turn: l.turn === "D" ? "Diurno" : "Noturno", hospital: l.hospital, unit: l.unit, doctor: l.doctor, crm: l.crm,
      in: asLocal(tz, l.check_in), out: asLocal(tz, l.check_out), hours: l.hours, late: l.lateMin,
      sit: l.tags.join(" / "), ind: l.in_dist, outd: l.out_dist, acc: l.in_acc, man: l.manual ? "sim" : "", outside: l.outside ? "sim" : "",
    });
    const sit = r.getCell("sit");
    if (l.tags.some((t) => t === "Sem check-in" || t === "Sem check-out")) sit.fill = fill("FFFDE4E1");
    else if (l.tags.some((t) => t.startsWith("Atraso") || t === "Saída antecipada")) sit.fill = fill("FFFDF0D9");
    else if (l.tags.includes("Pontual")) sit.fill = fill("FFDCF3E4");
  }
  ws.getRow(1).eachCell((c) => Object.assign(c, head)); ws.getRow(1).height = 30;
  ws.autoFilter = { from: "A1", to: "Q1" };

  // Aba 2: Resumo por médico
  const rs = wb.addWorksheet("Resumo por médico", { views: [{ state: "frozen", ySplit: 1 }] });
  rs.columns = [
    { header: "Médico", key: "doctor", width: 30 }, { header: "CRM", key: "crm", width: 10 },
    { header: "Plantões", key: "n", width: 10 }, { header: "Pontuais", key: "ok", width: 10 },
    { header: "Atrasos", key: "late", width: 10 }, { header: "Min. de atraso", key: "lateMin", width: 12 },
    { header: "Sem check-in", key: "noin", width: 12 }, { header: "Sem check-out", key: "noout", width: 12 },
    { header: "Saídas antecipadas", key: "early", width: 12 }, { header: "Ajustes manuais", key: "manual", width: 11 },
    { header: "Horas registradas", key: "hours", width: 12, style: { numFmt: "0.00" } },
  ];
  sums.forEach((s) => rs.addRow({ ...s, hours: Math.round(s.hours * 100) / 100 }));
  if (sums.length) {
    const last = sums.length + 1;
    const t = rs.addRow({ doctor: "Total", ...Object.fromEntries(["n", "ok", "late", "lateMin", "noin", "noout", "early", "manual", "hours"].map((k, i) => {
      const col = String.fromCharCode(67 + i); return [k, { formula: `SUM(${col}2:${col}${last})` }];
    })) });
    t.font = { bold: true };
  }
  rs.getRow(1).eachCell((c) => Object.assign(c, head)); rs.getRow(1).height = 30;

  // Aba 3: Sobre
  const info = wb.addWorksheet("Sobre");
  info.columns = [{ width: 34 }, { width: 70 }];
  const gen = asLocal(tz, now.toISOString())!;
  [["Relatório", "Presença dos plantonistas — Opus Scala"], ["Período", `${fmtBR(from)} a ${fmtBR(to)} (plantões que começaram nesse intervalo)`],
   ["Gerado em", gen.toISOString().slice(0, 16).replace("T", " ") + ` (${tz})`],
   ["Tolerância de atraso", `${d.settings.tolerance_min} min`],
   ["Pontual", "Check-in até o início do turno + tolerância"], ["Saída antecipada", "Check-out antes do fim do turno − tolerância"],
   ["Sem check-in / Sem check-out", "Plantão da escala sem o registro correspondente"],
   ["Ajuste manual", "Horário lançado ou alterado pelo gestor (com trilha de auditoria no sistema)"],
   ["Fora da escala atual", "Houve registro, mas o médico não está mais escalado nesse plantão (troca posterior)"],
   ["Horários", "Hora local; turnos D 7h–19h, N 19h–7h"]].forEach((r) => { const row = info.addRow(r); row.getCell(1).font = { bold: true }; });

  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function emailHtml(from: string, to: string, lines: Line[], sums: Sum[]): string {
  const tot = sums.reduce((a, s) => ({ n: a.n + s.n, ok: a.ok + s.ok, late: a.late + s.late, noin: a.noin + s.noin, noout: a.noout + s.noout, early: a.early + s.early, hours: a.hours + s.hours }), { n: 0, ok: 0, late: 0, noin: 0, noout: 0, early: 0, hours: 0 });
  const td = 'style="padding:6px 8px;border-bottom:1px solid #e3e8e8;text-align:right"';
  const tdl = 'style="padding:6px 8px;border-bottom:1px solid #e3e8e8"';
  const th = 'style="padding:6px 8px;background:#0b6e74;color:#fff;text-align:left;font-size:12px"';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#152325;max-width:720px">
<h2 style="color:#0b6e74;margin:0 0 4px">Presença dos plantonistas</h2>
<p style="margin:0 0 16px;color:#5b6d70">Semana de ${fmtBR(from)} a ${fmtBR(to)} · planilha completa em anexo</p>
${lines.length ? `<p style="font-size:15px"><b>${tot.n}</b> plantões · <b>${tot.ok}</b> pontuais · <b>${tot.late}</b> com atraso · <b style="color:#b42318">${tot.noin}</b> sem check-in · <b style="color:#b42318">${tot.noout}</b> sem check-out · <b>${tot.early}</b> saídas antecipadas · <b>${tot.hours.toFixed(1).replace(".", ",")}</b> h registradas</p>
<table style="border-collapse:collapse;font-size:13px;width:100%"><tr><th ${th}>Médico</th><th ${th}>Plantões</th><th ${th}>Pontuais</th><th ${th}>Atrasos</th><th ${th}>Sem check-in</th><th ${th}>Sem check-out</th><th ${th}>Horas</th></tr>
${sums.map((s) => `<tr><td ${tdl}>${esc(s.doctor)}</td><td ${td}>${s.n}</td><td ${td}>${s.ok}</td><td ${td}>${s.late}</td><td ${td}>${s.noin}</td><td ${td}>${s.noout}</td><td ${td}>${s.hours.toFixed(1).replace(".", ",")}</td></tr>`).join("")}
</table>` : `<p>Nenhum plantão escalado nesse período.</p>`}
<p style="font-size:12px;color:#5b6d70;margin-top:18px">Enviado automaticamente pelo Opus Scala toda segunda-feira. Ajustes e detalhes: aba Presença do app.</p></div>`;
}
