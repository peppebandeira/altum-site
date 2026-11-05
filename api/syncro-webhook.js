// POST /api/syncro-webhook: recebe eventos do Syncro (lead.stage_changed / lead.won).
// Não confia no corpo do evento: relê o lead na API antes de agir. Tudo é idempotente.
//  1) Lead entrou em "Embaixador ativo"  -> gera o código, etiqueta o embaixador e põe o link na tarefa.
//  2) Lead indicado entrou em "Ganho"     -> lança a comissão (tarefa na ficha do embaixador) e o bônus do mês.
const S = require('./_syncro');

const LINK_TAREFA = 'Gerar e enviar o link de indicação';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  const b = (typeof req.body === 'string' ? safeJSON(req.body) : req.body) || {};
  const d = b.data || {};
  const leadId = Number((d.lead && d.lead.id) || d.lead_id || d.id);
  console.log('evento', b.event, 'lead', leadId);
  if (!leadId) return res.status(200).json({ ok: true, ignorado: 'sem lead' });

  try {
    const j = await S.sx('GET', '/leads/' + leadId + '?include=sales');
    const lead = j.lead || j.data || j;
    let r = { ok: true, ignorado: 'nada a fazer' };
    if (lead.pipeline_id === S.IDS.embaixadores && lead.stage_id === S.IDS.etapaAtivo) r = await ativarEmbaixador(lead);
    else if (lead.pipeline_id === S.IDS.aquisicao && lead.stage_id === S.IDS.etapaGanho && S.codigoDaTag(lead.tags)) r = await lancarComissao(lead);
    return res.status(200).json(r);
  } catch (e) {
    console.error('webhook', e.message);
    // 5xx faz o Syncro reenviar; 404 de lead apagado não precisa de reenvio
    return res.status(e.status === 404 ? 200 : 500).json({ ok: false });
  }
};

async function codigoLivre(lead) {
  const partes = String(lead.name || '').trim().split(/\s+/).map(S.slug).filter(Boolean);
  const primeiro = partes[0] || 'embaixador';
  const ultimo = partes.length > 1 ? partes[partes.length - 1] : '';
  const opcoes = [primeiro];
  if (ultimo) opcoes.push(primeiro + ultimo[0], primeiro + ultimo);
  opcoes.push(primeiro + lead.id);
  for (const c of opcoes) {
    const usados = await S.listarLeads({ tags: [S.tagDoCodigo(c)] });
    if (!usados.some(l => (l.tags || []).includes(S.tagDoCodigo(c)))) return c;
  }
  return primeiro + lead.id;
}

async function ativarEmbaixador(lead) {
  let codigo = S.codigoDaTag(lead.tags);
  if (!codigo) {
    codigo = await codigoLivre(lead);
    await S.sx('POST', '/leads/' + lead.id + '/tags', { tags: [S.tagDoCodigo(codigo)] });
  }
  const link = S.SITE + '/i/' + codigo;
  const nome = S.primeiroNome(lead.name);
  const descricao =
    'Link pronto: https://' + link + '\n\n' +
    'Mensagem para mandar ao embaixador:\n' +
    nome + ', seu link de indicação do ALTUM está pronto: ' + link + '\n' +
    'Quem você indicar por ele entra no nosso CRM em seu nome. Se a pessoa já estiver em conversa com o ALTUM, o próprio link avisa na hora. ' +
    'Cada membro do Cúpula que fechar pela sua indicação gera 10% de comissão, paga quando o pagamento do membro compensar.';

  const tarefas = await S.tarefasDoLead(lead.id);
  const alvo = tarefas.find(t => t.subject === LINK_TAREFA);
  if (alvo) {
    if (!String(alvo.description || '').includes(link)) await S.sx('PUT', '/tasks/' + alvo.id, { description: descricao });
  } else if (!tarefas.some(t => String(t.subject || '').includes(link))) {
    await S.criarTarefa({ lead_id: lead.id, type: 'whatsapp', subject: 'Enviar o link de indicação: ' + link, description: descricao });
  }
  return { ok: true, ativado: codigo };
}

function faixaBonus(n) { return n >= 20 ? 5000 : n >= 15 ? 3000 : n >= 8 ? 1000 : 0; }

async function lancarComissao(lead) {
  const codigo = S.codigoDaTag(lead.tags);
  const emb = await S.acharEmbaixador(codigo);
  if (!emb) return { ok: true, ignorado: 'embaixador não encontrado: ' + codigo };

  const marca = '(#' + lead.id + ')';
  const tarefas = await S.tarefasDoLead(emb.id);
  if (tarefas.some(t => String(t.subject || '').includes(marca) && String(t.subject).indexOf('Comissão') === 0)) {
    return { ok: true, ignorado: 'comissão já lançada' };
  }

  const vendas = (lead.sales || []).filter(s => s.pipeline_id === S.IDS.aquisicao);
  const venda = vendas[vendas.length - 1];
  const valor = Number(lead.value || (venda && venda.value) || 0);
  const comissao = Math.round(valor * 0.10 * 100) / 100;
  const mes = S.mesSP(venda && venda.closed_at);

  // Contagem do embaixador: membros fechados no mês e no total
  const indicados = await S.listarLeads({ pipeline_id: S.IDS.aquisicao, tags: [S.tagDoCodigo(codigo)], include: 'sales' });
  let noMes = 0, total = 0;
  for (const l of indicados) {
    if (!(l.tags || []).includes(S.tagDoCodigo(codigo))) continue;
    const vs = (l.sales || []).filter(s => s.pipeline_id === S.IDS.aquisicao);
    if (!vs.length && l.id !== lead.id) continue;
    total++;
    const v = vs[vs.length - 1];
    if (S.mesSP(v && v.closed_at) === mes) noMes++;
  }
  if (!total) { total = 1; noMes = 1; }

  const cf = lead.custom_fields || {};
  const val = x => (x && typeof x === 'object' ? x.value : x) || '';
  const fora = val(cf.faixa_de_faturamento_anual) === 'Até R$500 mil' || val(cf.anos_de_operacao) === 'Menos de 2 anos';
  const [ano, m] = mes.split('-');

  const desc = [
    'Venda: ' + lead.name + (lead.company ? ' (' + lead.company + ')' : '') + ', negócio #' + lead.id + '.',
    'Valor do negócio: ' + (valor ? S.reais(valor) : 'não informado no Syncro, confira e recalcule') + '.',
    'Comissão padrão de 10%: ' + S.reais(comissao) + '. Se o embaixador fechou sozinho, com o pagamento feito e fora de evento, é 15%: ' + S.reais(Math.round(valor * 15) / 100) + '.',
    'Pagar quando o pagamento do membro compensar. Cartão parcelado: comissão integral quando a primeira parcela compensar.',
    'Membros fechados por ' + S.primeiroNome(emb.name) + ' em ' + m + '/' + ano + ': ' + noMes + '. No total: ' + total + '.',
    fora ? 'ATENÇÃO: o cadastro indica que o membro está fora do perfil (R$500 mil+/ano e 2+ anos). Pela regra, não gera comissão. Confira antes de pagar.' : ''
  ].filter(Boolean).join('\n');

  await S.criarTarefa({ lead_id: emb.id, subject: 'Comissão ' + S.reais(comissao) + ': ' + lead.name + ' ' + marca, description: desc });

  const bonusAgora = faixaBonus(noMes), bonusAntes = faixaBonus(noMes - 1);
  if (bonusAgora > bonusAntes) {
    await S.criarTarefa({
      lead_id: emb.id, priority: 'medium',
      subject: 'Bônus de ' + m + '/' + ano + ' sobe para ' + S.reais(bonusAgora) + ' (' + noMes + ' membros)',
      description: 'O bônus não soma, só progride: vale a maior faixa atingida no mês (8 = R$1.000, 15 = R$3.000, 20 = R$5.000). ' +
        (bonusAntes ? 'Este valor substitui o bônus de ' + S.reais(bonusAntes) + ' do mesmo mês. ' : '') + 'Pagar no fechamento do mês.'
    });
  }
  if (total === 10) {
    await S.criarTarefa({
      lead_id: emb.id, priority: 'medium',
      subject: S.primeiroNome(emb.name) + ' chegou a 10 membros: liberar 1 ano de Cúpula',
      description: '10 membros acumulados pela indicação. Pela regra do programa, o embaixador ganha 1 ano de Cúpula.'
    });
  }
  return { ok: true, comissao, noMes, total };
}

function safeJSON(s) { try { return JSON.parse(s); } catch (_) { return null; } }
