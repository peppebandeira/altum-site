// POST /api/indicar  : registra a indicação no Syncro, ou recusa se o contato já existe no CRM.
const S = require('./_syncro');

const FAIXAS = ['Até R$500 mil', 'R$500 mil a R$1 mi', 'R$1 mi a R$5 mi', 'R$5 mi a R$20 mi', 'Acima de R$20 mi'];
const ANOS = ['Menos de 2 anos', '2 a 5 anos', '5 a 10 anos', 'Mais de 10 anos'];

function limpa(s, max) { return String(s || '').trim().slice(0, max || 200); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const b = (typeof req.body === 'string' ? safeJSON(req.body) : req.body) || {};
  if (b.site) return res.status(200).json({ ok: true, status: 'registrada' }); // armadilha anti-robô

  const codigo = S.slug(b.codigo);
  const nome = limpa(b.nome, 120);
  const empresa = limpa(b.empresa, 120);
  const telefone = S.telefoneE164(b.whatsapp);
  const email = limpa(b.email, 160).toLowerCase();
  const faixa = FAIXAS.includes(b.faixa) ? b.faixa : '';
  const anos = ANOS.includes(b.anos) ? b.anos : '';
  const motivo = limpa(b.motivo, 1200);

  if (!codigo || !nome || !empresa || S.soDigitos(telefone).length < 12 || !faixa || !anos || b.autorizou !== true) {
    return res.status(400).json({ ok: false, status: 'incompleto' });
  }

  try {
    const emb = await S.acharEmbaixador(codigo);
    if (!emb || emb.stage_id !== S.IDS.etapaAtivo) return res.status(404).json({ ok: false, status: 'link_invalido' });

    const tagEmb = S.tagDoCodigo(codigo);

    // Trava: vale quem chegou primeiro. Se o contato já existe em qualquer funil, não registra.
    const existentes = await S.acharExistente(telefone, email);
    if (existentes.length) {
      const ex = existentes[0];
      try {
        const t = await S.criarTarefa({
          lead_id: emb.id, priority: 'low',
          subject: 'Indicação recusada: ' + nome + ' já estava no CRM (#' + ex.id + ')',
          description: 'O embaixador tentou indicar ' + nome + ' (' + empresa + '), que já estava no CRM: negócio #' + ex.id +
            ' no funil ' + ((ex.pipeline && ex.pipeline.name) || ex.pipeline_id) + '. A página avisou que a indicação não foi registrada. Só para registro.'
        });
        if (t && t.task && t.task.id) await S.sx('PUT', '/tasks/' + t.task.id, { status: 'completed' });
      } catch (e) { console.error('registro de recusa', e.message); }
      return res.status(409).json({ ok: false, status: 'ja_existe', nome: S.primeiroNome(nome) });
    }

    const foraDoPerfil = faixa === 'Até R$500 mil' || anos === 'Menos de 2 anos';
    const notas = [
      'Indicação de embaixador: ' + emb.name + ' (código ' + codigo + ', negócio #' + emb.id + ' no funil Embaixadores).',
      motivo ? 'Por que está no ponto: ' + motivo : '',
      foraDoPerfil ? 'Atenção: pelo que o embaixador informou, está fora do perfil do Cúpula (R$500 mil+/ano e 2+ anos). Sem comissão fora do perfil.' : ''
    ].filter(Boolean).join('\n\n');

    const lead = await S.sx('POST', '/leads', {
      name: nome,
      company: empresa,
      phone: telefone,
      email: email || undefined,
      pipeline_id: S.IDS.aquisicao,
      stage_id: S.IDS.etapaLead,
      assigned_to: S.IDS.user,
      source: 'indicacao-embaixador',
      tags: [S.TAG_INDICACAO, tagEmb],
      utm_source: 'embaixador',
      utm_medium: 'indicacao',
      utm_campaign: codigo,
      notes: notas,
      custom_fields: { faixa_de_faturamento_anual: faixa, anos_de_operacao: anos, indicado_por: emb.name }
    });

    return res.status(200).json({ ok: true, status: 'registrada', nome: S.primeiroNome(nome), fora_do_perfil: foraDoPerfil, id: lead.lead && lead.lead.id });
  } catch (e) {
    console.error('indicar', e.message);
    return res.status(502).json({ ok: false, status: 'erro' });
  }
};

function safeJSON(s) { try { return JSON.parse(s); } catch (_) { return null; } }
