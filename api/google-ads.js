// /api/google-ads.js
//
// Proxy serverless (Vercel Node.js Function) para a Google Ads API.
// Necessário porque, diferente da Meta Graph API, a Google Ads API:
//   1) não permite chamadas diretas do navegador (sem CORS);
//   2) exige client secret + developer token, que nunca podem ficar
//      expostos no código do front-end.
//
// Credenciais vêm de variáveis de ambiente configuradas no projeto na Vercel
// (Settings → Environment Variables), nunca do cliente:
//   GOOGLE_ADS_CLIENT_ID
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (opcional — ID da conta gerenciadora/MCC,
//                                   necessário se a conta de cliente é acessada
//                                   através de uma conta manager)
//
// O front-end só manda o Customer ID da conta que quer consultar (não é
// segredo, é só um identificador) e o período (since/until).

const API_VERSION = "v18";

module.exports = async (req, res) => {
  const { customerId, since, until } = req.query;

  const {
    GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN,
    GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  } = process.env;

  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_DEVELOPER_TOKEN) {
    res.status(500).json({
      error:
        "Credenciais do Google Ads não configuradas no servidor. Configure GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN e GOOGLE_ADS_DEVELOPER_TOKEN nas variáveis de ambiente da Vercel.",
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
    // 1) Troca o refresh token por um access token válido
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_ADS_CLIENT_ID,
        client_secret: GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      res.status(502).json({
        error: `Falha ao renovar token OAuth do Google (${tokenJson.error_description || tokenJson.error || tokenRes.status})`,
      });
      return;
    }
    const accessToken = tokenJson.access_token;

    // 2) Monta a query GAQL
    const cleanCustomerId = String(customerId).replace(/-/g, "");
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
      ORDER BY metrics.cost_micros DESC
    `;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": GOOGLE_ADS_DEVELOPER_TOKEN,
      "Content-Type": "application/json",
    };
    if (GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers["login-customer-id"] = String(GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, "");
    }

    const searchRes = await fetch(
      `https://googleads.googleapis.com/${API_VERSION}/customers/${cleanCustomerId}/googleAds:search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      }
    );
    const searchJson = await searchRes.json();

    if (!searchRes.ok) {
      const msg =
        (Array.isArray(searchJson) && searchJson[0]?.error?.message) ||
        searchJson?.error?.message ||
        JSON.stringify(searchJson);
      res.status(searchRes.status).json({ error: `Erro na Google Ads API: ${msg}` });
      return;
    }

    const results = searchJson.results || [];
    const campaigns = results.map((r) => ({
      id: r.campaign.id,
      name: r.campaign.name,
      status: r.campaign.status,
      channelType: r.campaign.advertisingChannelType,
      spend: Number(r.metrics?.costMicros || 0) / 1e6,
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      conversions: Number(r.metrics?.conversions || 0),
      conversionsValue: Number(r.metrics?.conversionsValue || 0),
      ctr: Number(r.metrics?.ctr || 0) * 100,
      avgCpc: Number(r.metrics?.averageCpc || 0) / 1e6,
    }));

    res.status(200).json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro desconhecido no proxy do Google Ads." });
  }
};
