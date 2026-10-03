// /api/_supabase.js
//
// Helper mínimo pra falar com a REST API do Supabase (PostgREST), sem
// precisar da dependência @supabase/supabase-js — só fetch puro, pra não
// mexer no build do projeto.
//
// Usa sempre a service_role key (nunca a anon/publishable): as tabelas do
// Blue Ads (blue_ads_clients, blue_ads_meta_daily, blue_ads_google_daily)
// têm Row Level Security ligado e NENHUMA policy pública — só quem tem a
// chave secreta (as funções serverless daqui) consegue ler ou escrever.
// Essa chave nunca deve ir pro navegador.
//
// Variáveis de ambiente necessárias na Vercel (projeto meta-performance):
//   SUPABASE_URL               -> https://syyljurqbgdfsmsjqyqu.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> Project Settings -> API -> service_role (secret)

function env() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados no servidor. Configure essas variáveis na Vercel."
    );
  }
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

function authHeaders() {
  const { SUPABASE_SERVICE_ROLE_KEY } = env();
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

// Lê registros de uma tabela via PostgREST.
// `query` é a query string do PostgREST, ex: "select=*&slug=eq.abc123"
async function select(table, query) {
  const { SUPABASE_URL } = env();
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase: falha ao ler ${table} (${r.status}): ${text}`);
  }
  return r.json();
}

// Insere/atualiza em lote (upsert), usando a constraint única indicada em
// `conflictCols` (string separada por vírgula, ex:
// "client_slug,level,entity_id,date").
async function upsert(table, rows, conflictCols) {
  if (!rows || rows.length === 0) return;
  const { SUPABASE_URL } = env();
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCols}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase: falha ao gravar em ${table} (${r.status}): ${text}`);
  }
}

module.exports = { select, upsert };   
