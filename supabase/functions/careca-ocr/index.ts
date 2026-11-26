// Leitura de faturas do admin.html: recebe o pedido generateContent já montado no browser,
// junta a chave do Gemini guardada no superadmin (careca.config), reencaminha para a Google e regista o uso.
// A resposta da Google volta tal e qual (mesmo estado HTTP), para o admin.html manter as tentativas e o modelo de reserva.
// shortcut: sem login no backoffice, qualquer pessoa com este URL pode gastar a quota; o teto é o orçamento mensal do painel. Ao ter login a sério, exigir o JWT do restaurante.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-modelo',
};
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const erro = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { status: 'CARECA', message } }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro(405, 'Use POST.');

  let input: { model?: string; request?: { contents?: unknown; generationConfig?: unknown } };
  try { input = await req.json(); } catch { return erro(400, 'Pedido inválido (JSON).'); }
  if (!Array.isArray(input?.request?.contents)) return erro(400, 'Pedido inválido: falta contents.');

  const { data: cfg, error } = await db.rpc('careca_gemini_preparar', { p_modelo: input.model || null });
  if (error) return erro(400, error.message);
  if (!cfg.chave) return erro(412, 'A chave do Gemini não está configurada. Configure-a no painel de métricas (metricas.html).');
  if (cfg.orcamento_usd != null && Number(cfg.gasto_mes_usd) >= Number(cfg.orcamento_usd)) {
    return erro(402, `Orçamento mensal do OCR esgotado (${Number(cfg.gasto_mes_usd).toFixed(2)} de ${cfg.orcamento_usd} USD). Aumente-o no painel de métricas.`);
  }

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.chave },
      body: JSON.stringify({ contents: input.request!.contents, generationConfig: input.request!.generationConfig }),
    });
  } catch (e) {
    await db.rpc('careca_gemini_registar', { p_modelo: cfg.modelo, p_entrada: 0, p_saida: 0, p_resultado: 'erro', p_duracao_ms: Date.now() - t0 });
    return erro(502, 'Sem ligação ao Gemini: ' + (e as Error).message);
  }
  const text = await res.text();
  let u: Record<string, number> = {};
  try { u = JSON.parse(text).usageMetadata || {}; } catch { /* resposta sem JSON: regista só o resultado */ }
  await db.rpc('careca_gemini_registar', {
    p_modelo: cfg.modelo,
    p_entrada: u.promptTokenCount || 0,
    p_saida: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), // o raciocínio paga como saída
    p_resultado: res.ok ? 'ok' : [429, 500, 503].includes(res.status) ? 'sobrecarga' : 'erro',
    p_duracao_ms: Date.now() - t0,
  });
  return new Response(text, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json', 'x-modelo': cfg.modelo } });
});
