'use strict';
// =====================================================================
// Ponte entre as telas e o Supabase.
// ---------------------------------------------------------------------
// Por que existe: as telas (app.js e login.js) foram feitas para chamar
// a API do servidor Node.js (/api/...). No GitHub Pages não há servidor.
// Este arquivo intercepta essas chamadas e as responde usando o Supabase,
// no mesmo formato de antes. Assim as telas mudam o mínimo possível.
//
// Segurança: quem decide o que cada pessoa pode ver ou alterar é o BANCO
// (regras RLS do 01_banco.sql), não este arquivo. Mesmo que alguém altere
// este código no navegador, o banco recusa o que o perfil não permite.
// =====================================================================
(() => {
  const cfg = window.GP_CONFIG || {};
  if (!window.supabase || !cfg.url || /COLE_AQUI/.test(cfg.url + cfg.chave)) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.textContent = 'Configuração do Supabase ausente: preencha web/config.js.';
    });
    return;
  }

  const sb = window.supabase.createClient(cfg.url, cfg.chave, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gp-sessao' },
  });
  window.gpSupabase = sb;

  const DIA = 86400000;
  const GENERICO = 'E-mail ou senha incorretos.';
  const SEM_PERMISSAO = 'Você não tem permissão para esta ação.';

  class Erro extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
  const exigir = (cond, status, msg) => { if (!cond) throw new Erro(status, msg); };
  const ms = (t) => (t ? Date.parse(t) : null);
  const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

  // Converte erros do Supabase em mensagens claras, no padrão das telas.
  function traduzir(e, padrao403 = SEM_PERMISSAO) {
    if (e instanceof Erro) return e;
    const code = e?.code || '';
    const msg = e?.message || '';
    if (code === 'PGRST301' || /JWT expired|invalid JWT/i.test(msg)) return new Erro(401, 'Sessão expirada. Entre novamente.');
    if (code === 'P0001') return new Erro(400, msg); // mensagens escritas nas regras do banco
    if (code === '42501' || /row-level security/i.test(msg)) return new Erro(403, padrao403);
    if (code === '23505') return new Erro(409, 'Já existe um projeto com este ID.');
    if (code === '23514' || code === '22P02' || code === '23502') return new Erro(400, 'Dados inválidos. Confira os campos.');
    if (code === '23503') return new Erro(400, 'Registro relacionado não encontrado.');
    return new Erro(500, 'Não foi possível concluir. Tente novamente.');
  }
  const ok = (r, padrao403) => { if (r.error) throw traduzir(r.error, padrao403); return r.data; };

  // ---------- sessão e perfil ----------
  let perfilCache = null;
  async function sessao() {
    const { data } = await sb.auth.getSession();
    return data.session;
  }
  async function meuPerfil(forcar) {
    const s = await sessao();
    if (!s) { perfilCache = null; throw new Erro(401, 'Sessão expirada. Entre novamente.'); }
    if (!forcar && perfilCache && perfilCache.id === s.user.id) return perfilCache;
    const p = ok(await sb.from('profiles').select('id, email, name, role, active, must_change_password').eq('id', s.user.id).maybeSingle());
    if (!p || !p.active) { await sb.auth.signOut(); perfilCache = null; throw new Erro(401, 'Sessão expirada. Entre novamente.'); }
    perfilCache = p;
    return p;
  }
  const pub = (p) => ({ id: p.id, email: p.email, name: p.name, role: p.role, mustChangePassword: !!p.must_change_password });

  // Saída automática por inatividade (padrão: 30 minutos)
  const CHAVE_ATIVIDADE = 'gp-ultima-atividade';
  const limiteInatividade = (cfg.minutosInatividade || 30) * 60000;
  const marcar = () => { try { localStorage.setItem(CHAVE_ATIVIDADE, String(Date.now())); } catch { /* sem armazenamento */ } };
  const ultima = () => { try { return Number(localStorage.getItem(CHAVE_ATIVIDADE)) || 0; } catch { return 0; } };
  async function verificarInatividade() {
    const s = await sessao();
    if (s && ultima() && Date.now() - ultima() > limiteInatividade) {
      await sb.auth.signOut();
      perfilCache = null;
      if (!/login\.html/.test(location.pathname)) location.replace('login.html');
    }
  }
  ['click', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, marcar, { passive: true }));
  setInterval(verificarInatividade, 60000);

  // Mesma política de senha do sistema original (validada também pelo Supabase)
  function politicaSenha(pw, { email = '', name = '' } = {}) {
    const erros = [];
    if (pw.length < 12) erros.push('Use pelo menos 12 caracteres.');
    if (pw.length > 128) erros.push('Use no máximo 128 caracteres.');
    const tipos = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
    if (tipos < 4) erros.push('Combine minúsculas, maiúsculas, números e símbolos.');
    if (/(.)\1{3,}/.test(pw)) erros.push('Evite repetir o mesmo caractere 4 vezes seguidas.');
    const baixa = pw.toLowerCase();
    const local = String(email).split('@')[0].toLowerCase();
    if (local.length >= 4 && baixa.includes(local)) erros.push('A senha não pode conter seu usuário de e-mail.');
    for (const parte of String(name).toLowerCase().split(/\s+/)) {
      if (parte.length >= 4 && baixa.includes(parte)) { erros.push('A senha não pode conter seu nome.'); break; }
    }
    return erros;
  }

  // Farol: mesma regra da planilha (src/metrics.js)
  function farol({ total, done, start_date: inicio, due_date: fim }) {
    const pct = total ? done / total : 0;
    if (total > 0 && done === total) return { farol: 'Concluído', pct };
    if (!inicio || !fim) return { farol: 'Sem data', pct };
    const toMs = (d) => Date.parse(d + 'T00:00:00');
    const agora = toMs(hojeSP()); const ini = toMs(inicio); const f = toMs(fim);
    if (agora > f && pct < 1) return { farol: 'Atrasado', pct };
    const decorrido = Math.max(0, (agora - ini) / Math.max(DIA, f - ini));
    if (decorrido - pct > 0.2) return { farol: 'Atenção', pct };
    return { farol: 'No prazo', pct };
  }
  const resumoQuadro = (b) => ({ ...b, ...farol(b) });

  // Chamada à função de servidor do admin (Edge Function)
  async function adminUsuarios(corpo) {
    const { data, error } = await sb.functions.invoke('admin-usuarios', { body: corpo });
    if (error) {
      const r = error.context;
      // Sem resposta (rede caiu ou o navegador bloqueou a chamada)
      if (!r || typeof r.json !== 'function') {
        throw new Erro(503, 'Não foi possível falar com a função "admin-usuarios" (rede ou bloqueio do navegador). Tente novamente.');
      }
      let corpo = {};
      try { corpo = await r.json(); } catch { /* resposta sem JSON */ }
      // Resposta da própria função: a mensagem já vem pronta em português.
      if (corpo.error) throw new Erro(r.status || 500, corpo.error);
      // Resposta do Supabase, antes de a função rodar: mostra o motivo real para facilitar o diagnóstico.
      // Por quê o status muda para 502: um 401 aqui não é sessão expirada, e não deve tirar o admin do sistema.
      const detalhe = corpo.message || corpo.msg || corpo.code || '';
      const msg = r.status === 404
        ? 'A função "admin-usuarios" não foi encontrada no Supabase. Confira se ela está publicada em Edge Functions.'
        : `A função "admin-usuarios" não rodou: o Supabase respondeu ${r.status}${detalhe ? ` (${detalhe})` : ''}. Veja os logs da função no Supabase.`;
      throw new Erro(502, msg);
    }
    return data;
  }

  // Conta linhas afetadas sem pedir o conteúdo de volta
  async function atualizar(tabela, valores, id, msg403) {
    const r = await sb.from(tabela).update(valores, { count: 'exact' }).eq('id', id);
    ok(r, msg403);
    exigir(r.count > 0, 403, msg403);
  }
  async function excluir(tabela, id, msg403) {
    const r = await sb.from(tabela).delete({ count: 'exact' }).eq('id', id);
    ok(r, msg403);
    exigir(r.count > 0, 403, msg403);
  }
  // Campos que ficam vazios (null) quando apagados; textos ficam como ''
  const ANULAVEIS = new Set(['owner_id', 'start_date', 'due_date', 'assignee_id']);
  const SO_VER = 'Seu perfil permite apenas visualizar este quadro.';
  const SO_GESTOR = 'Apenas gestores do quadro ou administradores podem fazer isso.';
  const num = (v) => { const n = Number(v); exigir(Number.isInteger(n) && n > 0, 400, 'Dados inválidos.'); return n; };
  // Checklists do cartão: até 10 por cartão, até 30 itens cada. Itens sem texto são descartados.
  function limparChecklists(v) {
    exigir(Array.isArray(v) && v.length <= 10, 400, 'Cada cartão pode ter no máximo 10 checklists.');
    return v.map((cl) => {
      const itens = Array.isArray(cl?.items) ? cl.items : [];
      exigir(itens.length <= 30, 400, 'Cada checklist pode ter no máximo 30 itens.');
      return { title: String(cl?.title ?? '').trim().slice(0, 80) || 'Checklist',
        items: itens.map((i) => ({ text: String(i?.text ?? '').trim().slice(0, 200), done: i?.done === true })).filter((i) => i.text) };
    });
  }
  const uuid = (v) => { exigir(typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v), 400, 'Dados inválidos.'); return v; };

  // ---------- rotas (mesmas da API original) ----------
  async function rota(method, caminho, body) {
    const [path, query] = caminho.split('?');
    const p = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');

    // ----- autenticação -----
    if (p[0] === 'auth' && p[1] === 'policy') return { minLength: 12 };
    if (p[0] === 'auth' && p[1] === 'login' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const { error } = await sb.auth.signInWithPassword({ email, password: String(body.password || '') });
      if (error) {
        if (error.status === 429) throw new Erro(429, 'Muitas tentativas de acesso. Aguarde alguns minutos.');
        throw new Erro(401, GENERICO);
      }
      let perfil;
      try { perfil = await meuPerfil(true); } catch { throw new Erro(401, GENERICO); }
      marcar();
      await sb.rpc('registrar_acesso');
      return { user: pub(perfil), csrfToken: '-' };
    }

    await verificarInatividade();
    const eu = await meuPerfil();

    if (p[0] === 'auth') {
      if (p[1] === 'me') { marcar(); return { user: pub(eu), csrfToken: '-' }; }
      if (p[1] === 'logout') { await sb.auth.signOut(); perfilCache = null; return { ok: true }; }
      if (p[1] === 'change-password') {
        const atual = String(body.currentPassword || ''); const nova = String(body.newPassword || '');
        exigir(nova !== atual, 400, 'A nova senha precisa ser diferente da atual.');
        const erros = politicaSenha(nova, eu); exigir(!erros.length, 400, erros.join(' '));
        // Confirma a senha atual antes de trocar
        const re = await sb.auth.signInWithPassword({ email: eu.email, password: atual });
        if (re.error) throw new Erro(400, 'A senha atual está incorreta.');
        const up = await sb.auth.updateUser({ password: nova });
        if (up.error) {
          if (/weak|characters|should contain|pwned/i.test(up.error.message)) {
            throw new Erro(400, 'Senha fraca: use 12+ caracteres com minúsculas, maiúsculas, números e símbolos.');
          }
          if (/different from the old/i.test(up.error.message)) throw new Erro(400, 'A nova senha precisa ser diferente da atual.');
          throw new Erro(400, 'Não foi possível alterar a senha.');
        }
        ok(await sb.rpc('concluir_troca_senha'));
        await sb.auth.signOut({ scope: 'others' }); // encerra as outras sessões
        perfilCache = null;
        return { ok: true };
      }
    }

    // A partir daqui é preciso ter trocado a senha temporária
    if (eu.must_change_password) throw new Erro(403, 'Troque sua senha para continuar.', 'PASSWORD_CHANGE_REQUIRED');

    // ----- usuários -----
    if (p[0] === 'users') {
      if (p[1] === 'directory') {
        return ok(await sb.from('profiles').select('id, name, email, role').eq('active', true).order('name'));
      }
      exigir(eu.role === 'admin', 403, SEM_PERMISSAO);
      if (!p[1] && method === 'GET') {
        const rows = ok(await sb.from('profiles').select('*').order('name'));
        return rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active,
          mustChangePassword: u.must_change_password, lockedUntil: null, lastLoginAt: ms(u.last_login_at), createdAt: ms(u.created_at) }));
      }
      if (!p[1] && method === 'POST') {
        return adminUsuarios({ acao: 'criar', email: body.email, name: body.name, role: body.role });
      }
      const id = uuid(p[1]);
      if (p[2] === 'reset-password') return adminUsuarios({ acao: 'redefinir_senha', userId: id });
      if (p[2] === 'unlock') return { ok: true }; // o Supabase controla bloqueios por tentativa sozinho
      if (method === 'PATCH') {
        if (body.name !== undefined || body.role !== undefined) {
          await adminUsuarios({ acao: 'alterar', userId: id, name: body.name, role: body.role });
        }
        if (body.active !== undefined) await adminUsuarios({ acao: body.active ? 'ativar' : 'desativar', userId: id });
        return { ok: true };
      }
    }

    // ----- quadros -----
    if (p[0] === 'boards') {
      if (!p[1] && method === 'GET') {
        return ok(await sb.from('v_quadros').select('*').order('code')).map(resumoQuadro);
      }
      if (!p[1] && method === 'POST') {
        const r = ok(await sb.rpc('criar_quadro', {
          p_name: body.name, p_code: body.code || null, p_description: body.description || '',
          p_area: body.area || '', p_sponsor: body.sponsor || '', p_owner: body.ownerId || null,
          p_priority: body.priority || 'Média', p_start: body.startDate || null, p_due: body.dueDate || null,
        }));
        return Array.isArray(r) ? r[0] : r;
      }
      const boardId = num(p[1]);

      if (!p[2] && method === 'GET') {
        const [qb, ql, qc, qm] = await Promise.all([
          sb.from('v_quadros').select('*').eq('id', boardId).maybeSingle(),
          sb.from('lists').select('id, name, position, is_done').eq('board_id', boardId).order('position'),
          sb.from('cards').select('*, assignee:profiles!cards_assignee_id_fkey(name)').eq('board_id', boardId).order('position'),
          sb.from('board_members').select('user:profiles(id, name, email, role, active)').eq('board_id', boardId),
        ]);
        const b = ok(qb); exigir(b, 404, 'Quadro não encontrado.');
        const membros = ok(qm).map((m) => m.user).filter((u) => u && u.active)
          .map(({ active, ...u }) => u).sort((a, c) => a.name.localeCompare(c.name));
        const souMembro = membros.some((m) => m.id === eu.id);
        const admin = eu.role === 'admin';
        return {
          board: resumoQuadro(b),
          permissions: {
            canEdit: admin || (souMembro && eu.role !== 'leitor'),
            canManage: admin || (souMembro && eu.role === 'gestor'),
          },
          lists: ok(ql).map((l) => ({ id: l.id, name: l.name, position: l.position, isDone: l.is_done })),
          cards: ok(qc).map((c) => ({ id: c.id, listId: c.list_id, title: c.title, description: c.description,
            assigneeId: c.assignee_id, assigneeName: c.assignee?.name ?? null, dueDate: c.due_date, priority: c.priority,
            phase: c.phase, checklists: Array.isArray(c.checklists) ? c.checklists : [],
            position: c.position, completedAt: ms(c.completed_at), updatedAt: ms(c.updated_at) })),
          members: membros,
        };
      }
      if (!p[2] && method === 'PATCH') {
        const mapa = { code: 'code', name: 'name', description: 'description', area: 'area', sponsor: 'sponsor',
          ownerId: 'owner_id', priority: 'priority', startDate: 'start_date', dueDate: 'due_date' };
        const v = {};
        for (const [k, col] of Object.entries(mapa)) if (body[k] !== undefined) v[col] = (body[k] === '' && ANULAVEIS.has(col)) ? null : body[k];
        if (v.start_date && v.due_date) exigir(v.due_date >= v.start_date, 400, 'O fim previsto não pode ser antes do início.');
        if (Object.keys(v).length) await atualizar('boards', v, boardId, SO_GESTOR);
        return { ok: true };
      }
      if (!p[2] && method === 'DELETE') { await atualizar('boards', { archived: true }, boardId, SO_GESTOR); return { ok: true }; }
      if (p[2] === 'members' && method === 'PUT') {
        ok(await sb.rpc('definir_membros', { p_board: boardId, p_users: (body.userIds || []).map(uuid) }), SO_GESTOR);
        return { ok: true };
      }
      if (p[2] === 'lists' && method === 'POST') {
        const r = ok(await sb.from('lists').insert({ board_id: boardId, name: body.name, is_done: !!body.isDone }).select('id').single(), SO_VER);
        return { id: r.id };
      }
      if (p[2] === 'cards' && method === 'POST') {
        const r = ok(await sb.from('cards').insert({
          board_id: boardId, list_id: num(body.listId), title: body.title, description: body.description || '',
          assignee_id: body.assigneeId || null, due_date: body.dueDate || null, priority: body.priority || 'Média', phase: body.phase || '',
          checklists: limparChecklists(body.checklists ?? []),
        }).select('id').single(), SO_VER);
        return { id: r.id };
      }
    }

    // ----- colunas -----
    if (p[0] === 'lists') {
      const id = num(p[1]);
      if (method === 'PATCH') {
        const v = {};
        if (body.name !== undefined) v.name = body.name;
        if (body.isDone !== undefined) v.is_done = !!body.isDone;
        if (Object.keys(v).length) await atualizar('lists', v, id, SO_VER);
        if (body.index !== undefined) ok(await sb.rpc('mover_lista', { p_list: id, p_index: Number(body.index) }), SO_VER);
        return { ok: true };
      }
      if (method === 'DELETE') { await excluir('lists', id, SO_VER); return { ok: true }; }
    }

    // ----- cartões -----
    if (p[0] === 'cards') {
      const id = num(p[1]);
      if (p[2] === 'move') {
        ok(await sb.rpc('mover_cartao', { p_card: id, p_list: num(body.listId), p_index: Number(body.index) || 0 }), SO_VER);
        return { ok: true };
      }
      if (method === 'PATCH') {
        const mapa = { title: 'title', description: 'description', assigneeId: 'assignee_id', dueDate: 'due_date', priority: 'priority', phase: 'phase' };
        const v = {};
        for (const [k, col] of Object.entries(mapa)) if (body[k] !== undefined) v[col] = (body[k] === '' && ANULAVEIS.has(col)) ? null : body[k];
        if (body.checklists !== undefined) v.checklists = limparChecklists(body.checklists);
        if (Object.keys(v).length) await atualizar('cards', v, id, SO_VER);
        return { ok: true };
      }
      if (method === 'DELETE') { await excluir('cards', id, SO_VER); return { ok: true }; }
    }

    // ----- painel de desempenho e auditoria -----
    if (p[0] === 'dashboard') {
      if (p[1] === 'audit') {
        exigir(eu.role === 'admin', 403, SEM_PERMISSAO);
        const limite = Math.min(500, Math.max(1, Number.parseInt(params.get('limit'), 10) || 200));
        const rows = ok(await sb.from('audit_log').select('*').order('id', { ascending: false }).limit(limite));
        return rows.map((r) => ({ id: r.id, at: ms(r.at), userEmail: r.user_email, action: r.action, entity: r.entity,
          entityId: r.entity_id, ip: r.ip, details: r.details == null ? null : JSON.stringify(r.details) }));
      }
      const t = hojeSP();
      const quadros = ok(await sb.from('v_quadros').select('*').order('code')).map(resumoQuadro);
      const ids = quadros.map((b) => b.id);
      let cartoes = [];
      if (ids.length) {
        cartoes = ok(await sb.from('cards')
          .select('assignee_id, due_date, completed_at, list:lists(is_done), assignee:profiles!cards_assignee_id_fkey(name)')
          .in('board_id', ids));
      }
      const d30 = Date.now() - 30 * DIA;
      const pessoas = new Map();
      for (const c of cartoes) {
        if (!c.assignee_id || !c.assignee) continue;
        const r = pessoas.get(c.assignee_id) || { id: c.assignee_id, name: c.assignee.name, open: 0, overdue: 0, done30: 0, onTime30: 0 };
        const feito = c.list?.is_done; const quando = ms(c.completed_at);
        if (!feito) { r.open++; if (c.due_date && c.due_date < t) r.overdue++; }
        else if (quando && quando >= d30) {
          r.done30++;
          const dia = new Date(quando).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
          if (!c.due_date || dia <= c.due_date) r.onTime30++;
        }
        pessoas.set(c.assignee_id, r);
      }
      const feitos = cartoes.filter((c) => c.list?.is_done && c.completed_at).map((c) => ms(c.completed_at));
      const throughput = Array.from({ length: 8 }, (_, i) => {
        const fim = Date.now() - (7 - i) * 7 * DIA; const ini = fim - 7 * DIA;
        return { weekEnding: new Date(fim).toLocaleDateString('sv-SE'), count: feitos.filter((x) => x > ini && x <= fim).length };
      });
      const boards = quadros.map((b) => ({ id: b.id, code: b.code, name: b.name, priority: b.priority, startDate: b.start_date,
        dueDate: b.due_date, ownerName: b.owner_name, total: b.total, done: b.done, overdue: b.overdue, pct: b.pct, farol: b.farol }));
      const totals = boards.reduce((a, b) => ({ total: a.total + b.total, done: a.done + b.done, overdue: a.overdue + b.overdue }), { total: 0, done: 0, overdue: 0 });
      return { today: t, boards, people: [...pessoas.values()].sort((a, b) => a.name.localeCompare(b.name)), throughput, totals };
    }

    throw new Erro(404, 'Recurso não encontrado.');
  }

  // ---------- intercepta as chamadas /api/... das telas ----------
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return fetchOriginal(url, opts);
    const method = (opts.method || 'GET').toUpperCase();
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }
    try {
      const r = await rota(method, url.slice(5), body);
      return new Response(JSON.stringify(r ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const err = traduzir(e);
      if (!(e instanceof Erro)) console.error('[gp]', e);
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status || 500, headers: { 'Content-Type': 'application/json' } });
    }
  };
})();
