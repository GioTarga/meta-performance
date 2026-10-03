// /api/google-ads.js
//
// Proxy serverless (Vercel Node.js Function) para dados do Google Ads
// vindos do Windsor.ai.
//
// Por quê um proxy em vez de chamar o Windsor direto do navegador?
//   1) A API do Windsor só aceita api_key como query param (sem header),
//      então a chave ficaria visível pra qualquer um que abrir o devtools.
//   2) Essa chave dá acesso a TODAS as contas conectadas no Windsor (Meta,
//      Google Ads, etc.), não só a do cliente que está sendo visto — um
//      raio de exposição grande demais pra deixar no código do front-end.
// Por isso a chave fica só aqui, como variável de ambiente no servidor:
//   WINDSOR_API_KEY
//
// O front-end manda só o ID da conta Google Ads (não é segredo) e o
// período (since/until). Essa function busca no Windsor, agrega os dados
// diários por campanha e devolve só o necessário pro dashboard.

const FIELDS = [
  "campaign",
  "campaign_id",
  "campaign_status",
  "date",
  "spend",
  "clicks",
  "impressions",
  "conversions",
  "ctr",
  "cpc",
].join(",");

module.exports = async (req, res) => {
  const { customerId, since, until } = req.query;
  const { WINDSOR_API_KEY } = process.env;

  if (!WINDSOR_API_KEY) {
    res.status(500).json({
      error: "WINDSOR_API_KEY não configurada no servidor. Configure essa variável de ambiente na Vercel.",
    });
    return;
  }

  if (!customerId) {
    res.status(400).json({ error: "Parâmetro customerId é obrigatório." });
    return;
  }

  if (!since || !until) {
    res.status(400).json({ error: "Parâmetros since e until (YYYY-MM-DD) são obrigatórios." });
    return;
  }

  try {
    const url = new URL("https://connectors.windsor.ai/google_ads");
    url.searchParams.set("api_key", WINDSOR_API_KEY);
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("date_from", since);
    url.searchParams.set("date_to", until);
    url.searchParams.set("select_accounts", customerId);

    const wRes = await fetch(url.toString());
    const wJson = await wRes.json();

    if (!wRes.ok || wJson.error) {
      res.status(wRes.ok ? 502 : wRes.status).json({
        error: wJson.error || `Erro na API do Windsor.ai (${wRes.status})`,
      });
      return;
    }

    const rows = wJson.data || [];

    // Agrega as linhas diárias (uma por campanha por dia) em totais por campanha
    const byCampaign = new Map();
    for (const r of rows) {
      const key = r.campaign_id || r.campaign;
      if (!byCampaign.has(key)) {
        byCampaign.set(key, {
          id: r.campaign_id,
          name: r.campaign,
          status: r.campaign_status,
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
        });
      }
      const c = byCampaign.get(key);
      c.spend += Number(r.spend || 0);
      c.impressions += Number(r.impressions || 0);
      c.clicks += Number(r.clicks || 0);
      c.conversions += Number(r.conversions || 0);
    }

    const campaigns = Array.from(byCampaign.values())
      .map((c) => ({
        ...c,
        ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : null,
        avgCpc: c.clicks > 0 ? c.spend / c.clicks : null,
      }))
      .sort((a, b) => b.spend - a.spend);

    res.status(200).json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro desconhecido no proxy do Google Ads." });
  }
};
