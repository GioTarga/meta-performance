// /api/client-info.js
//
// Resolve um "slug" de link de cliente (ex: ?c=a1b2c3d4) para o nome do
// cliente e quais contas (Meta/Google) ele deve ver. O cadastro de
// clientes mora no Supabase (tabela public.blue_ads_clients, dentro do
// projeto Assistente-financeiro) — não existe mais variável de ambiente
// pra manter sincronizada. O front-end chama este endpoint uma vez ao
// carregar um link de cliente, antes de pedir qualquer dado de
// performance.

const { select } = require("./_supabase");

module.exports = async (req, res) => {
  const { slug } = req.query;
  if (!slug) {
    res.status(404).json({ error: "Link inválido." });
    return;
  }

  try {
    const rows = await select(
      "blue_ads_clients",
      `select=name,meta_account_id,google_customer_id,active&slug=eq.${encodeURIComponent(slug)}&limit=1`
    );
    const rec = rows[0];
    if (!rec || rec.active === false) {
      res.status(404).json({ error: "Link inválido ou cliente não encontrado." });
      return;
    }
    res.status(200).json({
      name: rec.name || "Cliente",
      meta: rec.meta_account_id ? { accountId: rec.meta_account_id } : null,
      google: rec.google_customer_id ? { customerId: rec.google_customer_id } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro ao consultar o cadastro de clientes." });
  }
};
