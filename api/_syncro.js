// Ponte com a API do Syncro. Arquivo com "_" na frente: a Vercel não publica como rota.
const BASE = 'https://app.syncro.chat/api/v1';

const IDS = {
  user: 645,                 // Giuseppe Bandeira
  aquisicao: 477,            // funil Aquisição Cúpula
  etapaLead: 2593,           // Aquisição Cúpula > Lead
  etapaGanho: 2599,          // Aquisição Cúpula > Ganho
  embaixadores: 490,         // funil Embaixadores
  etapaAtivo: 2700           // Embaixadores > Embaixador ativo
};

const TAG_INDICACAO = 'Indicação embaixador';
const TAG_PREFIXO = 'Embaixador: ';
const SITE = 'altumecossistema.com.br';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sx(method, path, body, tentativa) {
  const key = process.env.SYNCRO_API_KEY;
  if (!key) { const e = new Error('SYNCRO_API_KEY ausente'); e.status = 500; throw e; }
  const r = await fetch(BASE + path, {
    method,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { j = { raw: txt.slice(0, 500) }; }
  if (r.status === 429 && !tentativa) {
    await sleep(Math.min(8, Number(j.retry_after) || 3) * 1000);
    return sx(method, path, body, 1);
  }
  if (!r.ok) {
    const e = new Error('Syncro ' + method + ' ' + path + ' ' + r.status + ' ' + JSON.stringify(j).slice(0, 400));
    e.status = r.status; e.body = j; throw e;
  }
  return j;
}

function qs(obj) {
  const p = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => p.push(encodeURIComponent(k + '[]') + '=' + encodeURIComponent(x)));
    else p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return p.length ? '?' + p.join('&') : '';
}

async function listarLeads(filtros) {
  const j = await sx('GET', '/leads' + qs(Object.assign({ per_page: 200 }, filtros)));
  return j.data || [];
}

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tagDoCodigo(codigo) { return TAG_PREFIXO + codigo; }

function codigoDaTag(tags) {
  const t = (tags || []).find(x => typeof x === 'string' && x.indexOf(TAG_PREFIXO) === 0);
  return t ? t.slice(TAG_PREFIXO.length).trim() : null;
}

// Embaixador dono do código (no funil Embaixadores). Devolve o lead ou null.
async function acharEmbaixador(codigo) {
  const c = slug(codigo);
  if (!c) return null;
  const tag = tagDoCodigo(c);
  const leads = await listarLeads({ pipeline_id: IDS.embaixadores, tags: [tag] });
  return leads.find(l => (l.tags || []).includes(tag)) || null;
}

function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

function telefoneE164(s) {
  let d = soDigitos(s);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d ? '+' + d : '';
}

// Procura o contato no CRM inteiro, por telefone e por e-mail.
async function acharExistente(telefone, email) {
  const achados = [];
  const d = soDigitos(telefone);
  if (d.length >= 8) {
    const fim = d.slice(-8);
    const r = await listarLeads({ q: fim });
    const ddd = x => { let n = soDigitos(x); if (n.length >= 12 && n.indexOf('55') === 0) n = n.slice(2); return n.length >= 10 ? n.slice(0, 2) : ''; };
    const meu = ddd(d);
    r.filter(l => soDigitos(l.phone).slice(-8) === fim && (!meu || !ddd(l.phone) || ddd(l.phone) === meu))
      .forEach(l => achados.push(l));
  }
  const e = String(email || '').trim().toLowerCase();
  if (e) {
    const r = await listarLeads({ q: e });
    r.filter(l => String(l.email || '').trim().toLowerCase() === e).forEach(l => achados.push(l));
  }
  return achados;
}

function hojeSP() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function mesSP(iso) { return new Date(iso || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7); }

function reais(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function primeiroNome(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

async function criarTarefa(t) {
  return sx('POST', '/tasks', Object.assign({ type: 'task', priority: 'high', due_date: hojeSP(), assigned_to: IDS.user }, t));
}

async function tarefasDoLead(leadId) {
  const j = await sx('GET', '/tasks' + qs({ lead_id: leadId, per_page: 200 }));
  return j.data || [];
}

module.exports = {
  IDS, TAG_INDICACAO, TAG_PREFIXO, SITE,
  sx, qs, listarLeads, slug, tagDoCodigo, codigoDaTag, acharEmbaixador,
  soDigitos, telefoneE164, acharExistente, hojeSP, mesSP, reais, primeiroNome,
  criarTarefa, tarefasDoLead
};
