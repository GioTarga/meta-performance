// /api/meta-ads.js
//
// Proxy serverless (Vercel) para os LINKS DE CLIENTE do Blue Ads
// (?c=<slug>). Em vez de chamar a Meta Graph API ao vivo a cada clique do
// cliente, lê os dados já sincronizados no Supabase (tabela
// public.blue_ads_meta_daily, populada periodicamente por
// /api/cron/sync-meta.js) e monta a resposta no MESMO formato que a Graph
// API devolveria — assim o front-end (fetchBundle/normalizeMetrics) não
// precisa saber a diferença, e não foi preciso mudar a lógica que já
// estava testada.
//
// Por que isso é melhor que chamar a Graph API direto pro cliente final:
//   1) O cliente nunca vê nem cola um token — ele nem chega a existir no
//      navegador dele.
//   2) O link do cliente continua funcionando mesmo se o token do Gio
//      expirar entre uma sincronização e outra (só a PRÓXIMA sincronização
//      falha, não a visualização dos dados já salvos).
//
// O modo "admin" do Blue Ads (o próprio Gio, com o token dele colado no
// navegador) não passa por aqui — continua chamando a Graph API direto.
//
// Variáveis de ambiente necessárias na Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { select } = require("./_supabase");

const ALLOWED_ENDPOINTS = new Set(["campaigns", "adsets", "ads", "insights"]);
const LEVEL_BY_ENDPOINT = { campaigns: "campaign", adsets: "adset", ads: "ad" };

async function getClientMetaAccount(slug) {
  if (!slug) return null;
  const rows = await select(
    "blue_ads_clients",
    `select=meta_account_id,active&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  const rec = rows[0];
  if (!rec || rec.active === false || !rec.meta_account_id) return null;
  return rec.meta_account_id;
}

// Reconstrói um objeto "insight" a partir de um conjunto de linhas diárias
// (de UMA entidade ao longo do período, ou de TODAS as entidades em UM
// único dia) — soma o que é somável e recalcula as razões (cpm/ctr/cpc/
// frequency) a partir das somas, nunca fazendo média de razão já
// calculada. O resultado "principal" (leads/conversas/compras/etc.) e o
// rótulo dele já vêm prontos do Meta Ads (campo `results` e
// `result_label` gravados por dia na sincronização) — não precisamos
// reconstruir a partir de `actions` como fazíamos antes.
function buildInsight(rows) {
  let spend = 0, impressions = 0, clicks = 0, reach = 0, results = 0;
  let resultLabel = null, labelDate = null;

  for (const r of rows) {
    spend += Number(r.spend || 0);
    impressions += Number(r.impressions || 0);
    clicks += Number(r.clicks || 0);
    reach += Number(r.reach || 0);
    results += Number(r.results || 0);
    if (r.result_label && (!labelDate || r.date >= labelDate)) {
      resultLabel = r.result_label;
      labelDate = r.date;
    }
  }

  return {
    spend,
    impressions,
    reach: reach || null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    frequency: reach > 0 ? impressions / reach : null,
    // Campo próprio (nunca existe numa resposta real da Graph API), lido
    // por normalizeMetrics() no front-end pra pular a lógica de `actions`.
    __synthetic_result__: {
      results: results || null,
      costPerResult: results > 0 ? spend / results : null,
      resultType: resultLabel || (results > 0 ? "Resultados" : null),
    },
  };
}

function latestOf(rows) {
  return rows.reduce((best, r) => (!best || r.date >= best.date ? r : best), null);
}

module.exports = async (req, res) => {
  const { slug, endpoint, since, until, effective_status } = req.query;

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    res.status(400).json({ error: `Endpoint inválido: ${endpoint}` });
    return;
  }
  if (!since || !until) {
    res.status(400).json({ error: "Parâmetros since e until (YYYY-MM-DD) são obrigatórios." });
    return;
  }

  let metaAccountId;
  try {
    metaAccountId = await getClientMetaAccount(slug);
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro ao consultar o cadastro de clientes." });
    return;
  }
  if (!metaAccountId) {
    res.status(404).json({ error: "Link inválido ou este cliente não tem conta Meta configurada." });
    return;
  }

  let statusFilter = null;
  if (effective_status) {
    try {
      statusFilter = new Set(JSON.parse(effective_status));
    } catch (e) {
      statusFilter = null;
    }
  }

  try {
    if (endpoint === "insights") {
      // Série temporal no nível de conta: soma todas as campanhas por dia.
      const rows = await select(
        "blue_ads_meta_daily",
        `select=date,spend,impressions,clicks,reach,results,result_label` +
          `&client_slug=eq.${encodeURIComponent(slug)}&level=eq.campaign&date=gte.${since}&date=lte.${until}`
      );
      const byDate = new Map();
      for (const r of rows) {
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date).push(r);
      }
      const data = Array.from(byDate.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, dayRows]) => ({ date_start: date, ...buildInsight(dayRows) }));
      res.status(200).json({ data });
      return;
    }

    const level = LEVEL_BY_ENDPOINT[endpoint];
    const rows = await select(
      "blue_ads_meta_daily",
      `select=*&client_slug=eq.${encodeURIComponent(slug)}&level=eq.${level}&date=gte.${since}&date=lte.${until}`
    );

    const byEntity = new Map();
    for (const r of rows) {
      if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
      byEntity.get(r.entity_id).push(r);
    }

    const data = [];
    for (const [entityId, entityRows] of byEntity.entries()) {
      const latest = latestOf(entityRows);
      if (statusFilter && !statusFilter.has(latest.status)) continue;
      const meta = latest.meta || {};
      const insight = buildInsight(entityRows);

      if (level === "campaign") {
        data.push({
          id: entityId,
          name: latest.entity_name,
          objective: meta.objective || null,
          effective_status: latest.status || null,
          daily_budget: meta.daily_budget ?? null, // gravado em centavos na sincronização, igual ao formato da Graph API
          bid_strategy: meta.bid_strategy || null,
          insights: { data: [insight] },
        });
      } else if (level === "adset") {
        data.push({
          id: entityId,
          name: latest.entity_name,
          campaign_id: latest.campaign_id,
          optimization_goal: meta.optimization_goal || null,
          start_time: meta.start_time || null,
          daily_budget: meta.daily_budget ?? null,
          effective_status: latest.status || null,
          targeting:
            meta.audience_size_lower_bound != null
              ? { audience_size_lower_bound: meta.audience_size_lower_bound }
              : null,
          insights: { data: [insight] },
        });
      } else {
        data.push({
          id: entityId,
          name: latest.entity_name,
          adset_id: latest.adset_id,
          campaign_id: latest.campaign_id,
          effective_status: latest.status || null,
          // Sem thumbnail de criativo nesse caminho simplificado (a
          // sincronização via Meta Ads MCP não traz esse campo) — a célula
          // de criativo aparece em branco pro cliente nessa página.
          creative: null,
          insights: { data: [insight] },
        });
      }
    }

    res.status(200).json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro ao consultar dados do Supabase." });
  }
};
