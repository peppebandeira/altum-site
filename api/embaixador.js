// GET /api/embaixador?c=cecilia  ->  { ok, nome } (só o primeiro nome, para a página)
const S = require('./_syncro');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const c = S.slug(req.query.c);
    if (!c) return res.status(404).json({ ok: false });
    const emb = await S.acharEmbaixador(c);
    if (!emb || emb.stage_id !== S.IDS.etapaAtivo) return res.status(404).json({ ok: false });
    return res.status(200).json({ ok: true, nome: S.primeiroNome(emb.name) });
  } catch (e) {
    console.error('embaixador', e.message);
    return res.status(502).json({ ok: false, erro: 'indisponivel' });
  }
};
