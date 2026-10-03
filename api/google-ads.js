// /api/google-ads.js
//
// Proxy serverless (Vercel Node.js Function) para dados do Google Ads
// vindos do Windsor.ai. Suporta múltiplos "recursos" via ?resource=:
//   accounts        -> lista as contas Google Ads conectadas no Windsor
//   campaigns       -> métricas agregadas por campanha (padrão)
//   adgroups        -> métricas agregadas por grupo de anúncios
//   ads             -> métricas agregadas por anúncio
//   recommendations -> optimization score + recomendações de orçamento + impression share
//   timeseries      -> métricas agregadas por dia (toda a conta), pro gráfico de evolução diária
//
// Por quê um proxy em vez de chamar o Windsor direto do navegador?
//   1) A API do Windsor só aceita api_key como query param (sem header),
//      então a chave ficaria visível pra qualquer um que abrir o devtools.
//   2) Essa chave dá acesso a TODAS as contas conectadas no Windsor (Meta,
//      Google Ads, etc.), não só a do cliente que está sendo visto — um
//      raio de exposição grande demais pra deixar no código do front-end.
// Por isso a chave fica só aqui, como variável de ambiente no servidor:
//   WINDSOR_API_KEY

const { select } = require("./_supabase");

const CONNECTOR_URL = "https://connectors.windsor.ai/google_ads";
const ACCOUNTS_URL = "https://onboard.windsor.ai/api/common/ds-accounts";

// Pra links de cliente (?c=<slug>): resolve o slug pra conta Google Ads via o
// Supabase (tabela public.blue_ads_clients, projeto Assistente-financeiro).
// O customerId vindo do cliente é sempre ignorado quando um slug é informado,
// pra ninguém conseguir ver a conta de outro cliente só adulterando a URL.
async function getClientRecord(slug) {
  if (!slug) return null;
  const rows = await select(
    "blue_ads_clients",
    `select=name,meta_account_id,google_customer_id,active&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  const rec = rows[0];
  if (!rec || rec.active === false) return null;
  return { name: rec.name, metaAccountId: rec.meta_account_id, googleCustomerId: rec.google_customer_id };
}

// Em modo cliente (slug presente), em vez de chamar o Windsor ao vivo,
// lemos os dados já sincronizados no Supabase (public.blue_ads_google_daily,
// populado por /api/cron/sync-google.js) e agregamos no mesmo formato que o
// front-end já espera — mesma lógica de soma/razão de aggregate(), só que a
// partir do banco em vez das linhas cruas do Windsor.
async function readDailyFromSupabase(slug, level, since, until) {
  const rows = await select(
    "blue_ads_google_daily",
    `select=*&client_slug=eq.${encodeURIComponent(slug)}&level=eq.${level}&date=gte.${since}&date=lte.${until}`
  );
  return aggregate(rows.map((r) => ({ ...r, _status: r.status, _strength: r.ad_strength })), "entity_id", (r) => ({
    id: r.entity_id,
    name: r.entity_name,
    adGroupName: r.adgroup_name,
    campaignName: r.campaign_name,
    status: r.status,
    adStrength: r.ad_strength,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
  }));
}

// Mesma ideia de readDailyFromSupabase, mas agrupando por data (soma de todas
// as campanhas da conta no dia) em vez de por entidade — é o formato que o
// gráfico de evolução diária (ex.: conversões por dia) espera. Usa level
// "campaign" pra não contar o mesmo investimento em duplicidade (adgroup/ad
// são granularidades menores da mesma campanha).
async function readDailyTimeSeriesFromSupabase(slug, since, until) {
  const rows = await select(
    "blue_ads_google_daily",
    `select=date,spend,impressions,clicks,conversions&client_slug=eq.${encodeURIComponent(slug)}&level=eq.campaign&date=gte.${since}&date=lte.${until}`
  );
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
    const d = byDate.get(r.date);
    d.spend += Number(r.spend || 0);
    d.impressions += Number(r.impressions || 0);
    d.clicks += Number(r.clicks || 0);
    d.conversions += Number(r.conversions || 0);
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function windsorGet(baseUrl, params, apiKey) {
  const url = new URL(baseUrl);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const json = await res.json();
  return { res, json };
}

function aggregate(rows, keyField, buildBase) {
  const map = new Map();
  for (const r of rows) {
    const key = r[keyField];
    if (!map.has(key)) map.set(key, buildBase(r));
    const c = map.get(key);
    c.spend += Number(r.spend || 0);
    c.impressions += Number(r.impressions || 0);
    c.clicks += Number(r.clicks || 0);
    c.conversions += Number(r.conversions || 0);
    // campos "estado atual" (status, ad_strength) — fica com o valor mais recente não-nulo
    if (c._lastDate === undefined || r.date >= c._lastDate) {
      if (r._status !== undefined && r._status !== null) c.status = r._status;
      if (r._strength !== undefined && r._strength !== null) c.adStrength = r._strength;
      c._lastDate = r.date;
    }
  }
  return Array.from(map.values()).map((c) => {
    const { _lastDate, ...rest } = c;
    return {
      ...rest,
      ctr: rest.impressions > 0 ? (rest.clicks / rest.impressions) * 100 : null,
      avgCpc: rest.clicks > 0 ? rest.spend / rest.clicks : null,
    };
  });
}

module.exports = async (req, res) => {
  const { since, until, resource, slug } = req.query;
  let { customerId } = req.query;
  const { WINDSOR_API_KEY } = process.env;

  if (slug) {
    let rec;
    try {
      rec = await getClientRecord(slug);
    } catch (err) {
      res.status(500).json({ error: err.message || "Erro ao consultar o cadastro de clientes." });
      return;
    }
    if (!rec || !rec.googleCustomerId) {
      res.status(404).json({ error: "Link inválido ou este cliente não tem conta Google Ads configurada." });
      return;
    }
    customerId = rec.googleCustomerId; // ignora qualquer customerId vindo do cliente
  }

  const kind = resource || "campaigns";

  // ---------- Modo cliente (?c=<slug>): lê do Supabase, nunca do Windsor ao vivo ----------
  // Cobre só os recursos "performance pura" que o link de cliente usa
  // (campaigns/adgroups/ads). "recommendations" não é exibido pra clientes
  // (fica em Recomendações/Andromeda, página só-admin) e "accounts" é só do
  // seletor de contas do Gio — por isso nenhum dos dois precisa de um
  // caminho via banco.
  if (slug && kind === "timeseries") {
    if (!since || !until) {
      res.status(400).json({ error: "Parâmetros since e until (YYYY-MM-DD) são obrigatórios." });
      return;
    }
    try {
      const timeSeries = await readDailyTimeSeriesFromSupabase(slug, since, until);
      res.status(200).json({ timeSeries });
    } catch (err) {
      res.status(500).json({ error: err.message || "Erro ao consultar dados do Supabase." });
    }
    return;
  }

  if (slug && (kind === "campaigns" || kind === "adgroups" || kind === "ads")) {
    if (!since || !until) {
      res.status(400).json({ error: "Parâmetros since e until (YYYY-MM-DD) são obrigatórios." });
      return;
    }
    const levelByKind = { campaigns: "campaign", adgroups: "adgroup", ads: "ad" };
    const resultKeyByKind = { campaigns: "campaigns", adgroups: "adGroups", ads: "ads" };
    try {
      const items = (await readDailyFromSupabase(slug, levelByKind[kind], since, until)).sort(
        (a, b) => b.spend - a.spend
      );
      res.status(200).json({ [resultKeyByKind[kind]]: items });
    } catch (err) {
      res.status(500).json({ error: err.message || "Erro ao consultar dados do Supabase." });
    }
    return;
  }

  if (!WINDSOR_API_KEY) {
    res.status(500).json({
      error: "WINDSOR_API_KEY não configurada no servidor. Configure essa variável de ambiente na Vercel.",
    });
    return;
  }

  try {
    // ---------- Lista de contas conectadas (não precisa de customerId/datas) ----------
    if (kind === "accounts") {
      const { res: wRes, json: wJson } = await windsorGet(
        ACCOUNTS_URL,
        { datasource: "google_ads" },
        WINDSOR_API_KEY
      );
      if (!wRes.ok) {
        res.status(wRes.status).json({ error: `Erro ao listar contas no Windsor.ai (${wRes.status})` });
        return;
      }
      const list = Array.isArray(wJson) ? wJson : wJson.data || wJson.accounts || [];
      const accounts = list.map((a) => ({
        id: a.account_id || a.id,
        name: a.account_name || a.name || a.account_id || a.id,
      }));
      res.status(200).json({ accounts });
      return;
    }

    // ---------- Recursos que precisam de customerId + período ----------
    if (!customerId) {
      res.status(400).json({ error: "Parâmetro customerId é obrigatório." });
      return;
    }
    if (!since || !until) {
      res.status(400).json({ error: "Parâmetros since e until (YYYY-MM-DD) são obrigatórios." });
      return;
    }

    if (kind === "campaigns") {
      const { res: wRes, json: wJson } = await windsorGet(
        CONNECTOR_URL,
        {
          fields: "campaign,campaign_id,campaign_status,date,spend,clicks,impressions,conversions",
          date_from: since,
          date_to: until,
          select_accounts: customerId,
        },
        WINDSOR_API_KEY
      );
      if (!wRes.ok || wJson.error) {
        res.status(wRes.ok ? 502 : wRes.status).json({ error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})` });
        return;
      }
      const rows = (wJson.data || []).map((r) => ({ ...r, _status: r.campaign_status }));
      const campaigns = aggregate(rows, "campaign_id", (r) => ({
        id: r.campaign_id,
        name: r.campaign,
        status: r.campaign_status,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      })).sort((a, b) => b.spend - a.spend);
      res.status(200).json({ campaigns });
      return;
    }

    if (kind === "adgroups") {
      const { res: wRes, json: wJson } = await windsorGet(
        CONNECTOR_URL,
        {
          fields: "campaign,ad_group_name,ad_group_id,ad_group_status,date,spend,clicks,impressions,conversions",
          date_from: since,
          date_to: until,
          select_accounts: customerId,
        },
        WINDSOR_API_KEY
      );
      if (!wRes.ok || wJson.error) {
        res.status(wRes.ok ? 502 : wRes.status).json({ error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})` });
        return;
      }
      const rows = (wJson.data || []).map((r) => ({ ...r, _status: r.ad_group_status }));
      const adGroups = aggregate(rows, "ad_group_id", (r) => ({
        id: r.ad_group_id,
        name: r.ad_group_name,
        campaignName: r.campaign,
        status: r.ad_group_status,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      })).sort((a, b) => b.spend - a.spend);
      res.status(200).json({ adGroups });
      return;
    }

    if (kind === "ads") {
      const { res: wRes, json: wJson } = await windsorGet(
        CONNECTOR_URL,
        {
          fields:
            "campaign,ad_group_name,ad_group_ad_ad_id,ad_group_ad_status,ad_group_ad_ad_strength,date,spend,clicks,impressions,conversions",
          date_from: since,
          date_to: until,
          select_accounts: customerId,
        },
        WINDSOR_API_KEY
      );
      if (!wRes.ok || wJson.error) {
        res.status(wRes.ok ? 502 : wRes.status).json({ error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})` });
        return;
      }
      const rows = (wJson.data || []).map((r) => ({
        ...r,
        _status: r.ad_group_ad_status,
        _strength: r.ad_group_ad_ad_strength,
      }));
      const ads = aggregate(rows, "ad_group_ad_ad_id", (r) => ({
        id: r.ad_group_ad_ad_id,
        adGroupName: r.ad_group_name,
        campaignName: r.campaign,
        status: r.ad_group_ad_status,
        adStrength: r.ad_group_ad_ad_strength,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      })).sort((a, b) => b.spend - a.spend);
      res.status(200).json({ ads });
      return;
    }

    if (kind === "timeseries") {
      const { res: wRes, json: wJson } = await windsorGet(
        CONNECTOR_URL,
        {
          fields: "date,spend,clicks,impressions,conversions",
          date_from: since,
          date_to: until,
          select_accounts: customerId,
        },
        WINDSOR_API_KEY
      );
      if (!wRes.ok || wJson.error) {
        res.status(wRes.ok ? 502 : wRes.status).json({ error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})` });
        return;
      }
      const byDate = new Map();
      for (const r of wJson.data || []) {
        if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
        const d = byDate.get(r.date);
        d.spend += Number(r.spend || 0);
        d.impressions += Number(r.impressions || 0);
        d.clicks += Number(r.clicks || 0);
        d.conversions += Number(r.conversions || 0);
      }
      const timeSeries = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      res.status(200).json({ timeSeries });
      return;
    }

    if (kind === "recommendations") {
      const { res: wRes, json: wJson } = await windsorGet(
        CONNECTOR_URL,
        {
          fields:
            "campaign,campaign_id,campaign_status,date,optimization_score,has_recommended_budget,recommended_budget_amount,recommended_budget_estimated_change_weekly_clicks,search_impression_share,search_budget_lost_impression_share,search_rank_lost_impression_share",
          date_from: since,
          date_to: until,
          select_accounts: customerId,
        },
        WINDSOR_API_KEY
      );
      if (!wRes.ok || wJson.error) {
        res.status(wRes.ok ? 502 : wRes.status).json({ error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})` });
        return;
      }
      const rows = wJson.data || [];
      // Pega o valor do dia mais recente por campanha (são métricas de "estado atual", não cumulativas)
      const byCampaign = new Map();
      for (const r of rows) {
        const key = r.campaign_id;
        if (!byCampaign.has(key) || r.date > byCampaign.get(key).date) {
          byCampaign.set(key, r);
        }
      }
      const recommendations = Array.from(byCampaign.values())
        .filter((r) => r.campaign_status === "ENABLED")
        .map((r) => ({
          campaignId: r.campaign_id,
          campaignName: r.campaign,
          date: r.date,
          optimizationScore: r.optimization_score !== null && r.optimization_score !== undefined ? Number(r.optimization_score) * 100 : null,
          hasRecommendedBudget: r.has_recommended_budget === "True" || r.has_recommended_budget === true,
          recommendedBudgetAmount: r.recommended_budget_amount ? Number(r.recommended_budget_amount) / 1e6 : null,
          estimatedWeeklyClicksGain: r.recommended_budget_estimated_change_weekly_clicks ?? null,
          searchImpressionShare: r.search_impression_share !== null && r.search_impression_share !== undefined ? Number(r.search_impression_share) * 100 : null,
          searchBudgetLostIS: r.search_budget_lost_impression_share !== null && r.search_budget_lost_impression_share !== undefined ? Number(r.search_budget_lost_impression_share) * 100 : null,
          searchRankLostIS: r.search_rank_lost_impression_share !== null && r.search_rank_lost_impression_share !== undefined ? Number(r.search_rank_lost_impression_share) * 100 : null,
        }))
        .sort((a, b) => (a.optimizationScore ?? 100) - (b.optimizationScore ?? 100));
      res.status(200).json({ recommendations });
      return;
    }

    res.status(400).json({ error: `Recurso desconhecido: ${kind}` });
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro desconhecido no proxy do Google Ads." });
  }
};
