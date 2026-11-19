// Edge Function "relatorio-semanal": gera a planilha de presença da semana anterior e envia por e-mail (Brevo).
// Chamada pelo pg_cron com o cabeçalho x-cron-token. Corpo opcional: {"from":"AAAA-MM-DD","to":"AAAA-MM-DD","dry_run":true}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { buildLines, buildWorkbook, emailHtml, previousWeek, summarize, type Data } from "./report.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function fetchAll(q: () => any) {
  let all: any[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await q().range(i, i + 999);
    if (error) throw error; all = all.concat(data || []); if (!data || data.length < 1000) break;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: ok } = await sb.rpc("check_cron_token", { p_token: req.headers.get("x-cron-token") || "" });
  if (!ok) return json({ error: "não autorizado" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const { data: st, error: e1 } = await sb.from("settings").select("*").eq("id", 1).single();
    if (e1) throw e1;
    const now = new Date();
    const per = previousWeek(st.tz, now);
    const from: string = body.from || per.from, to: string = body.to || per.to;
    const [hospitals, units, doctors, shifts, attendance] = await Promise.all([
      fetchAll(() => sb.from("hospitals").select("*").order("id")),
      fetchAll(() => sb.from("units").select("*").order("id")),
      fetchAll(() => sb.from("doctors").select("id,name,crm,active").order("id")),
      fetchAll(() => sb.from("shifts").select("*").gte("date", from).lte("date", to).order("id")),
      fetchAll(() => sb.from("attendance").select("*").gte("shift_date", from).lte("shift_date", to).order("shift_id")),
    ]);
    const d: Data = { settings: st, hospitals, units, doctors, shifts, attendance };
    const lines = buildLines(d, from, to, now), sums = summarize(lines);
    const xlsx = await buildWorkbook(d, from, to, now, lines, sums);
    const recipients = String(st.report_to || "").split(/[,;\s]+/).filter(Boolean);
    if (body.dry_run) return json({ from, to, lines: lines.length, doctors: sums.length, bytes: xlsx.length, recipients });
    const key = Deno.env.get("BREVO_API_KEY");
    if (!key) throw new Error("Segredo BREVO_API_KEY não cadastrado em Edge Functions > Secrets.");
    if (!recipients.length) throw new Error("settings.report_to vazio.");
    const br = (s: string) => s.split("-").reverse().join("/");
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: st.report_from_name || "Opus Scala", email: st.report_from },
        to: recipients.map((email) => ({ email })),
        subject: `Opus Scala · presença de ${br(from)} a ${br(to)}`,
        htmlContent: emailHtml(from, to, lines, sums),
        attachment: [{ name: `presenca_${from}_a_${to}.xlsx`, content: encodeBase64(xlsx) }],
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${JSON.stringify(out)}`);
    console.log("relatorio enviado", { from, to, lines: lines.length, recipients, messageId: out.messageId });
    return json({ sent: true, from, to, lines: lines.length, recipients, messageId: out.messageId });
  } catch (e) {
    console.error("relatorio erro", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
