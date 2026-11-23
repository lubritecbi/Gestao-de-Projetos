'use strict';
// Front-end sem bibliotecas externas. Regra de segurança: dados do usuário entram no DOM
// SOMENTE via textContent/atributos (nunca innerHTML), o que impede XSS armazenado.
(() => {
  const state = { me: null, csrf: null, directory: [] };
  const app = document.getElementById('app');
  const dlg = document.getElementById('dlg');
  const ROLES = { admin: 'Administrador', gestor: 'Gestor', membro: 'Membro', leitor: 'Leitor' };
  const PRIORIDADES = ['Alta', 'Média', 'Baixa'];
  const FASES = ['', '1. Iniciação', '2. Planejamento', '3. Execução', '4. Testes / Piloto', '5. Implantação / Encerramento'];

  // ---------- utilitários ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'value') n.value = v;
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const fmtData = (d) => (d ? d.split('-').reverse().join('/') : '');
  const fmtHora = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR') : '');
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;
  const hoje = () => new Date().toLocaleDateString('sv-SE');

  function aviso(msg, tipo = 'ok') {
    const t = el('div', { class: 'aviso', role: 'status', dataset: { tipo }, text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    // Pedidos que alteram dados vão sempre como JSON (mesmo sem conteúdo, como nas exclusões):
    // a proteção CSRF do servidor próprio recusa o que não for JSON.
    if (body !== undefined || method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
    if (method !== 'GET') opts.headers['X-CSRF-Token'] = state.csrf;
    const r = await fetch('/api' + url, opts);
    if (r.status === 401) { location.replace('/login'); throw new Error('Sessão expirada.'); }
    let data = {};
    try { data = await r.json(); } catch { /* sem corpo */ }
    if (r.status === 403 && data.code === 'PASSWORD_CHANGE_REQUIRED') { location.replace('/login?trocar=1'); throw new Error(data.error); }
    if (!r.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
    return data;
  }
  const tentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, 'erro'); } };

  function campo(label, input, ajuda) {
    if (!input.id) input.id = 'c' + Math.random().toString(36).slice(2, 9);
    return el('div', { class: 'campo' }, el('label', { for: input.id, text: label }), input, ajuda ? el('span', { class: 'ajuda', text: ajuda }) : null);
  }
  function seletor(opcoes, valor) {
    return el('select', {}, opcoes.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(valor ?? '') })));
  }

  // ---------- diálogo ----------
  function abrirDialogo(titulo, corpo, acoes) {
    dlg.replaceChildren(
      el('div', { class: 'dlg-topo' }, el('h2', { id: 'dlg-titulo', text: titulo }),
        el('button', { class: 'btn btn-fantasma', type: 'button', 'aria-label': 'Fechar', text: '✕', onclick: () => dlg.close() })),
      el('div', { class: 'dlg-corpo' }, corpo),
      el('div', { class: 'dlg-acoes' }, acoes),
    );
    dlg.showModal();
  }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  function mostrarSenhaTemporaria(nome, senha) {
    const caixa = el('div', { class: 'senha-temp', text: senha });
    abrirDialogo('Senha temporária', [
      el('p', { text: `Entregue esta senha a ${nome} por um canal seguro (pessoalmente ou mensagem direta). Ela aparece só agora e será trocada no primeiro acesso.` }),
      caixa,
    ], [
      el('button', { class: 'btn', type: 'button', text: 'Copiar', onclick: tentar(async () => { await navigator.clipboard.writeText(senha); aviso('Senha copiada.'); }) }),
      el('button', { class: 'btn btn-primario', type: 'button', text: 'Concluir', onclick: () => dlg.close() }),
    ]);
  }

  // ---------- confirmação e entrada de texto (sem confirm/prompt nativos) ----------
  const dlgConf = document.getElementById('dlg-conf');
  function confirmar(msg, rotuloTexto) {
    return new Promise((ok) => {
      const entrada = rotuloTexto ? el('input', { maxlength: 80 }) : null;
      let resp = null;
      dlgConf.replaceChildren(
        el('div', { class: 'dlg-corpo' }, el('p', { text: msg }), entrada ? campo(rotuloTexto, entrada) : null),
        el('div', { class: 'dlg-acoes' },
          el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlgConf.close() }),
          el('button', { class: 'btn btn-primario', type: 'button', text: entrada ? 'Adicionar' : 'Confirmar',
            onclick: () => { resp = entrada ? entrada.value.trim() : true; dlgConf.close(); } })));
      dlgConf.addEventListener('close', () => ok(resp || (entrada ? null : false)), { once: true });
      dlgConf.showModal(); if (entrada) entrada.focus();
    });
  }
  const pedirTexto = (rotulo) => confirmar('Informe o nome:', rotulo);

  // ---------- navegação ----------
  function montarNav(rota) {
    const itens = [['#/', 'Quadros'], ['#/desempenho', 'Desempenho']];
    if (state.me.role === 'admin') itens.push(['#/usuarios', 'Usuários'], ['#/auditoria', 'Auditoria']);
    document.getElementById('nav').replaceChildren(...itens.map(([h, t]) =>
      el('a', { href: h, text: t, 'aria-current': (h === '#/' ? (rota === '' || rota.startsWith('quadro') || rota === 'arquivados') : rota.startsWith(h.slice(2))) ? 'page' : null })));
  }

  async function rotear() {
    const rota = location.hash.replace(/^#\/?/, '');
    montarNav(rota);
    dlg.open && dlg.close();
    try {
      if (rota.startsWith('quadro/')) await telaQuadro(Number(rota.split('/')[1]));
      else if (rota === 'arquivados' && state.me.role === 'admin') await telaArquivados();
      else if (rota === 'desempenho') await telaDesempenho();
      else if (rota === 'usuarios' && state.me.role === 'admin') await telaUsuarios();
      else if (rota === 'auditoria' && state.me.role === 'admin') await telaAuditoria();
      else await telaQuadros();
      app.focus({ preventScroll: true });
    } catch (e) {
      app.replaceChildren(el('div', { class: 'vazio', text: e.message }));
    }
  }

  // ---------- tela: lista de quadros ----------
  async function telaQuadros() {
    const quadros = await api('GET', '/boards');
    const podeCriar = ['admin', 'gestor'].includes(state.me.role);
    app.replaceChildren(
      el('div', { class: 'cabecalho' },
        el('div', {}, el('h1', { text: 'Quadros de projeto' }), el('p', { text: 'Cada projeto é um quadro. Abra um quadro para mover as atividades entre as colunas.' })),
        el('div', { class: 'acoes' },
          state.me.role === 'admin' ? el('a', { class: 'btn', href: '#/arquivados', text: 'Projetos arquivados' }) : null,
          podeCriar ? el('button', { class: 'btn btn-primario', type: 'button', text: 'Novo projeto', onclick: () => dialogoQuadro() }) : null)),
      quadros.length
        ? el('div', { class: 'quadros' }, quadros.map((q) => {
          const barra = el('span'); barra.style.width = pct(q.pct);
          return el('a', { class: 'quadro-item', href: `#/quadro/${q.id}` },
            el('span', { class: 'codigo', text: q.code }),
            el('h2', { text: q.name }),
            el('div', { class: 'progresso', role: 'img', 'aria-label': `${pct(q.pct)} concluído` }, barra),
            el('div', { class: 'rodape' },
              el('span', { class: 'farol', dataset: { f: q.farol }, text: q.farol }),
              el('span', { text: `${q.done} de ${q.total} atividades${q.overdue ? `, ${q.overdue} atrasada(s)` : ''}` })));
        }))
        : el('div', { class: 'vazio', text: podeCriar ? 'Nenhum projeto ainda. Crie o primeiro em "Novo projeto".' : 'Você ainda não participa de nenhum projeto. Peça a um gestor para incluí-lo.' }),
    );
  }

  async function carregarDiretorio() {
    state.directory = await api('GET', '/users/directory');
  }

  function dialogoQuadro(b, membros = []) {
    const f = {
      code: el('input', { value: b?.code || '', maxlength: 20, placeholder: 'Gerado automaticamente' }),
      name: el('input', { value: b?.name || '', maxlength: 120, required: true }),
      description: el('textarea', { maxlength: 4000, value: b?.description || '' }),
      area: el('input', { value: b?.area || '', maxlength: 120 }),
      sponsor: el('input', { value: b?.sponsor || '', maxlength: 120 }),
      ownerId: seletor([['', 'Sem responsável'], ...state.directory.map((u) => [u.id, u.name])], b?.owner_id ?? state.me.id),
      priority: seletor(PRIORIDADES.map((p) => [p, p]), b?.priority || 'Média'),
      startDate: el('input', { type: 'date', value: b?.start_date || '' }),
      dueDate: el('input', { type: 'date', value: b?.due_date || '' }),
    };
    const ids = new Set(membros.map((m) => m.id));
    const caixas = state.directory.map((u) => {
      const cb = el('input', { type: 'checkbox', value: u.id, checked: ids.has(u.id) });
      return { cb, label: el('label', {}, cb, `${u.name} (${ROLES[u.role]})`) };
    });
    const erro = el('p', { class: 'erro', role: 'alert' });
    const corpo = [
      el('div', { class: 'grade-2' }, campo('ID do projeto', f.code), campo('Prioridade', f.priority)),
      campo('Nome do projeto', f.name), campo('Objetivo / descrição', f.description),
      el('div', { class: 'grade-2' }, campo('Área solicitante', f.area), campo('Sponsor', f.sponsor),
        campo('Início', f.startDate), campo('Fim previsto', f.dueDate)),
      campo('Responsável', f.ownerId),
      b ? el('div', { class: 'campo' }, el('span', { class: 'ajuda', text: 'Membros com acesso ao quadro' }), el('div', { class: 'membros' }, caixas.map((c) => c.label))) : null,
      erro,
    ];
    const salvar = async () => {
      erro.textContent = '';
      const dados = {
        name: f.name.value, description: f.description.value, area: f.area.value, sponsor: f.sponsor.value,
        ownerId: f.ownerId.value ? Number(f.ownerId.value) : null, priority: f.priority.value,
        startDate: f.startDate.value || null, dueDate: f.dueDate.value || null,
      };
      if (f.code.value.trim()) dados.code = f.code.value.trim();
      try {
        if (b) {
          await api('PATCH', `/boards/${b.id}`, dados);
          await api('PUT', `/boards/${b.id}/members`, { userIds: caixas.filter((c) => c.cb.checked).map((c) => Number(c.cb.value)) });
          dlg.close(); aviso('Projeto atualizado.'); rotear();
        } else {
          const r = await api('POST', '/boards', dados);
          dlg.close(); aviso('Projeto criado.'); location.hash = `#/quadro/${r.id}`;
        }
      } catch (e) { erro.textContent = e.message; }
    };
    const arquivar = tentar(async () => {
      if (!await confirmar('Arquivar este projeto? Ele sai da lista de quadros de todos os membros. Nada é apagado: o administrador consulta e desarquiva em "Projetos arquivados".')) return;
      await api('DELETE', `/boards/${b.id}`); dlg.close(); aviso('Projeto arquivado.'); location.hash = '#/';
    });
    abrirDialogo(b ? 'Editar projeto' : 'Novo projeto', corpo, [
      b ? el('button', { class: 'btn btn-perigo esq', type: 'button', text: 'Arquivar projeto', onclick: arquivar }) : null,
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { class: 'btn btn-primario', type: 'button', text: b ? 'Salvar alterações' : 'Criar projeto', onclick: salvar }),
    ]);
  }

  // ---------- tela: quadro kanban + etiqueta ----------
  let cartaoSel = null;

  // ---------- tela: projetos arquivados (só administrador) ----------
  // Arquivar não apaga nada: aqui o admin consulta (somente leitura) e desarquiva.
  async function desarquivar(b) {
    if (!await confirmar(`Desarquivar o projeto ${b.code} ${b.name}? Ele volta para a lista de quadros de todos os membros.`)) return false;
    await api('POST', `/boards/${b.id}/unarchive`);
    aviso('Projeto desarquivado.');
    return true;
  }
  async function telaArquivados() {
    const quadros = await api('GET', '/boards/archived');
    app.replaceChildren(
      el('div', { class: 'cabecalho' },
        el('div', {}, el('h1', { text: 'Projetos arquivados' }),
          el('p', { text: 'Arquivar não apaga nada: cartões, checklists, anexos e histórico continuam guardados. Abra para consultar (somente leitura) ou desarquive para voltar a usar.' })),
        el('div', { class: 'acoes' }, el('a', { class: 'btn', href: '#/', text: 'Voltar aos quadros' }))),
      quadros.length
        ? el('section', { class: 'secao' }, el('div', { class: 'rolagem' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Projeto', 'Responsável', 'Área', 'Atividades', 'Arquivado em', ''].map((h, i) => el('th', { class: i === 3 ? 'num' : null, text: h })))),
          el('tbody', {}, quadros.map((b) => el('tr', {},
            el('td', {}, el('a', { href: `#/quadro/${b.id}`, text: `${b.code} ${b.name}` })),
            el('td', { text: b.ownerName || '' }),
            el('td', { text: b.area || '' }),
            el('td', { class: 'num', text: `${b.done}/${b.total}` }),
            el('td', { text: fmtHora(b.archivedAt).slice(0, 10) }),
            el('td', { class: 'acoes-linha' },
              el('a', { class: 'btn btn-fantasma', href: `#/quadro/${b.id}`, text: 'Abrir' }),
              el('button', { class: 'btn btn-fantasma', type: 'button', text: 'Desarquivar',
                onclick: tentar(async () => { if (await desarquivar(b)) rotear(); }) }))))))))
        : el('div', { class: 'vazio', text: 'Nenhum projeto arquivado.' }),
    );
  }

  async function telaQuadro(id) {
    const d = await api('GET', `/boards/${id}`);
    const { board: b, permissions: perm } = d;
    const listaDe = (c) => d.lists.find((x) => x.id === c.listId) || {};
    if (!d.cards.some((c) => c.id === cartaoSel)) {
      const escolhido = d.cards.find((c) => !listaDe(c).isDone && c.dueDate && c.dueDate < hoje())
        || d.cards.find((c) => !listaDe(c).isDone) || d.cards[0];
      cartaoSel = escolhido ? escolhido.id : null;
    }
    const barra = el('span'); barra.style.width = pct(b.pct);
    const resumo = [b.code, b.area, b.owner_name && `Responsável: ${b.owner_name}`, b.due_date && `Fim previsto: ${fmtData(b.due_date)}`].filter(Boolean).join(' | ');
    const painel = el('aside', { class: 'painel-etiqueta', 'aria-label': 'Etiqueta do cartão selecionado', 'aria-live': 'polite' });
    const kanban = el('div', { class: 'kanban' }, d.lists.map((l) => coluna(l, d, perm, painel)),
      perm.canEdit ? el('div', { class: 'nova-coluna' }, el('button', { class: 'btn', type: 'button', text: '+ Nova coluna',
        onclick: tentar(async () => {
          const nome = await pedirTexto('Nome da nova coluna'); if (!nome) return;
          await api('POST', `/boards/${id}/lists`, { name: nome }); rotear();
        }) })) : null);
    const nCols = d.lists.length + (perm.canEdit ? 1 : 0);
    kanban.style.gridTemplateColumns = `repeat(${d.lists.length}, minmax(200px, 1fr))${perm.canEdit ? ' 150px' : ''}`;
    kanban.style.minWidth = `${d.lists.length * 200 + (perm.canEdit ? 150 : 0)}px`;
    app.replaceChildren(
      el('div', { class: 'cabecalho' },
        el('div', {},
          el('h1', { text: b.name }),
          el('p', { text: resumo }),
          el('p', {}, el('span', { class: 'farol', dataset: { f: b.farol }, text: `${b.farol}, ${pct(b.pct)} concluído` }))),
        el('div', { class: 'acoes' },
          perm.canManage ? el('button', { class: 'btn', type: 'button', text: 'Editar projeto e membros',
            onclick: tentar(async () => { await carregarDiretorio(); dialogoQuadro(b, d.members); }) }) : null,
          perm.canEdit && d.lists.length ? el('button', { class: 'btn btn-primario', type: 'button', text: 'Adicionar cartão',
            onclick: () => dialogoCartao(null, d, d.lists[0].id) }) : null)),
      // replaceChildren escreveria "null" na tela: por isso a faixa entra como lista (vazia se o projeto estiver ativo).
      ...(b.archived ? [el('div', { class: 'faixa-arquivado', role: 'status' },
        el('span', {}, el('strong', { text: 'Projeto arquivado · somente leitura.' }), ' Nada pode ser alterado até ele ser desarquivado.'),
        el('span', { class: 'acoes' },
          el('a', { class: 'btn btn-fantasma', href: '#/arquivados', text: 'Ver arquivados' }),
          state.me.role === 'admin' ? el('button', { class: 'btn', type: 'button', text: 'Desarquivar',
            onclick: tentar(async () => { if (await desarquivar(b)) rotear(); }) }) : null))] : []),
      el('div', { class: 'progresso', role: 'img', 'aria-label': `${pct(b.pct)} concluído` }, barra),
      el('div', { class: 'oculto', id: 'instr-dnd', text: 'Selecione o cartão e use Avançar etapa ou Voltar etapa na etiqueta ao lado.' }),
      el('div', { class: 'area-quadro' }, el('div', { class: 'kanban-rolagem' }, kanban), painel),
    );
    montarEtiqueta(painel, d, perm);
  }

  function estadoPrazo(c, lista) {
    if (lista.isDone) return 'feito';
    if (!c.dueDate) return '';
    if (c.dueDate < hoje()) return 'atrasado';
    const dias = (Date.parse(c.dueDate) - Date.parse(hoje())) / 86400000;
    return dias <= 3 ? 'proximo' : '';
  }
  // Soma os itens de todas as checklists do cartão: { feitos, total }.
  function resumoChecklists(c) {
    const itens = (c.checklists || []).flatMap((cl) => cl.items || []);
    return { feitos: itens.filter((i) => i.done).length, total: itens.length };
  }
  const diasAte = (data) => Math.round((Date.parse(data) - Date.parse(hoje())) / 86400000);

  let arrastado = null;
  function coluna(l, d, perm, painel) {
    const cartoes = d.cards.filter((c) => c.listId === l.id);
    const temAtraso = cartoes.some((c) => estadoPrazo(c, l) === 'atrasado');
    const area = el('div', { class: 'cartoes', dataset: { list: l.id } }, cartoes.map((c) => cartao(c, l, d, perm, painel)));
    if (!cartoes.length) {
      area.append(el('div', { class: 'coluna-vazia' },
        el('img', { src: '/img/chip-vazio.svg', alt: '', width: '132', height: '52' }),
        el('p', { text: perm.canEdit ? 'Nenhum cartão aqui. Avance um cartão para cá.' : 'Nenhum cartão aqui.' })));
    }
    if (perm.canEdit) {
      const marcador = el('div', { class: 'marcador' });
      const indice = (y) => {
        const itens = [...area.querySelectorAll('.cartao:not(.arrastando)')];
        const i = itens.findIndex((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; });
        return i === -1 ? itens.length : i;
      };
      area.addEventListener('dragover', (e) => {
        if (!arrastado) return;
        e.preventDefault(); area.classList.add('alvo');
        const itens = [...area.querySelectorAll('.cartao:not(.arrastando)')];
        const i = indice(e.clientY);
        if (itens[i]) area.insertBefore(marcador, itens[i]); else area.append(marcador);
      });
      area.addEventListener('dragleave', (e) => { if (!area.contains(e.relatedTarget)) { area.classList.remove('alvo'); marcador.remove(); } });
      area.addEventListener('drop', tentar(async (e) => {
        e.preventDefault(); area.classList.remove('alvo'); marcador.remove();
        if (!arrastado) return;
        const idx = indice(e.clientY);
        const cid = arrastado; arrastado = null;
        cartaoSel = cid;
        await api('PATCH', `/cards/${cid}/move`, { listId: l.id, index: idx });
        rotear();
      }));
    }
    const menu = perm.canEdit ? el('button', { class: 'btn btn-fantasma', type: 'button', 'aria-label': `Opções da coluna ${l.name}`, text: '⋯',
      onclick: () => dialogoColuna(l, d) }) : null;
    return el('section', { class: 'coluna', 'aria-label': l.isDone ? `${l.name} (coluna de conclusão)` : l.name,
      title: l.isDone ? 'Cartões aqui contam como concluídos' : null },
      el('div', { class: 'coluna-topo' },
        el('h3', { text: l.name }),
        el('span', { class: 'trilha', 'aria-hidden': 'true' }),
        el('span', { class: 'via', 'aria-hidden': 'true', dataset: { estado: temAtraso ? 'atraso' : cartoes.length ? 'ativo' : 'vazio' } }),
        el('span', { class: 'qtd', text: String(cartoes.length), 'aria-label': `${cartoes.length} cartões${temAtraso ? ', com atraso' : ''}` }),
        menu),
      area,
      perm.canEdit ? el('button', { class: 'btn btn-fantasma novo-cartao', type: 'button', text: '+ Adicionar cartão',
        onclick: () => dialogoCartao(null, d, l.id) }) : null);
  }

  function cartao(c, l, d, perm, painel) {
    const prazo = estadoPrazo(c, l);
    const chk = resumoChecklists(c);
    const prazoCurto = l.isDone ? 'feito' : !c.dueDate ? '' : prazo === 'atrasado' ? `-${-diasAte(c.dueDate)}d` : fmtData(c.dueDate).slice(0, 5);
    const n = el('button', { class: 'cartao', type: 'button', draggable: perm.canEdit ? 'true' : null,
      'aria-describedby': 'instr-dnd', 'aria-pressed': String(c.id === cartaoSel), dataset: { prazo, id: c.id },
      onclick: () => {
        cartaoSel = c.id;
        app.querySelectorAll('.cartao').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.id === String(c.id))));
        montarEtiqueta(painel, d, perm);
      },
      ondblclick: () => dialogoCartao(c, d) },
      el('span', { class: 'linha-topo' }, el('span', { text: `#${c.id}` }),
        el('span', { class: 'prazo', text: prazoCurto, 'aria-label': prazo === 'atrasado' ? `atrasado desde ${fmtData(c.dueDate)}` : null })),
      el('span', { class: 'titulo', text: c.title }),
      el('span', { class: 'linha-base' },
        el('span', { class: 'resp', text: c.assigneeName || 'Sem responsável' }),
        el('span', { class: 'marcas' },
          c.attachmentCount ? el('span', { class: 'anexo-qtd', 'aria-label': `${c.attachmentCount} ${c.attachmentCount === 1 ? 'anexo' : 'anexos'}`, text: String(c.attachmentCount) }) : null,
          chk.total ? el('span', { class: 'check', dataset: { completo: chk.feitos === chk.total ? '1' : '0' },
            'aria-label': `checklist: ${chk.feitos} de ${chk.total} itens marcados`, text: `${chk.feitos}/${chk.total}` }) : null)));
    if (perm.canEdit) {
      n.addEventListener('dragstart', (e) => { arrastado = c.id; n.classList.add('arrastando'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c.id)); });
      n.addEventListener('dragend', () => { n.classList.remove('arrastando'); arrastado = null; });
    }
    return n;
  }

  function montarEtiqueta(painel, d, perm) {
    const c = d.cards.find((x) => x.id === cartaoSel);
    if (!c) {
      painel.replaceChildren(el('p', { class: 'painel-vazio', text: d.cards.length ? 'Selecione um cartão para ver os detalhes.' : 'Este quadro ainda não tem cartões.' }));
      return;
    }
    const idx = d.lists.findIndex((l) => l.id === c.listId);
    const lista = d.lists[idx];
    const est = estadoPrazo(c, lista);
    const chkEt = resumoChecklists(c);
    const dias = c.dueDate ? diasAte(c.dueDate) : null;
    const prazoLongo = lista.isDone ? (c.dueDate ? `${fmtData(c.dueDate)}, concluído` : 'Concluído')
      : !c.dueDate ? 'Sem prazo'
        : dias < 0 ? `${fmtData(c.dueDate)}, atrasado há ${-dias} ${-dias === 1 ? 'dia' : 'dias'}`
          : dias === 0 ? `${fmtData(c.dueDate)}, vence hoje`
            : `${fmtData(c.dueDate)}, em ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
    const faixaTxt = est === 'atrasado' ? 'Atrasado' : est === 'feito' ? 'Entregue' : est === 'proximo' ? 'Vence logo' : c.dueDate ? 'No prazo' : 'Sem prazo';
    const mover = (passo) => tentar(async () => {
      const alvo = d.lists[idx + passo]; if (!alvo) return;
      await api('PATCH', `/cards/${c.id}/move`, { listId: alvo.id, index: 100000 });
      aviso(`#${c.id} movido para ${alvo.name}.`); rotear();
    });
    const campoEt = (rotulo, valor, extra = {}) => el('div', { class: extra.largo ? 'largo' : null },
      el('dt', { text: rotulo }), el('dd', { class: extra.mono ? 'mono' : null, text: valor }));
    painel.replaceChildren(
      el('div', { class: 'faixa', dataset: { estado: est } }, el('strong', { text: lista.name }), el('span', { text: faixaTxt })),
      el('div', { class: 'cabeca' }, el('span', { class: 'codigo', text: `#${c.id}` }), el('h2', { text: c.title })),
      el('dl', {},
        campoEt('Projeto', d.board.code, { mono: true }),
        campoEt('Prioridade', c.priority),
        campoEt('Responsável', c.assigneeName || 'Sem responsável'),
        campoEt('Fase', c.phase || 'Sem fase'),
        campoEt('Prazo', prazoLongo, { largo: true, mono: true }),
        chkEt.total ? campoEt('Checklist', `${chkEt.feitos} de ${chkEt.total} itens marcados`, { largo: true }) : null,
        c.attachmentCount ? campoEt('Anexos', `${c.attachmentCount} ${c.attachmentCount === 1 ? 'arquivo' : 'arquivos'}`, { largo: true }) : null),
      el('div', { class: 'corpo' },
        c.description ? el('p', { class: 'descricao', text: c.description }) : null,
        el('ol', { class: 'etapas', 'aria-label': 'Etapas do cartão' }, d.lists.map((l, i) =>
          el('li', { class: i < idx ? 'passou' : null, 'aria-current': i === idx ? 'step' : null },
            el('span', { class: 'no', 'aria-hidden': 'true' }, el('span', { class: 'pad' }), el('span', { class: 'seg' })),
            el('span', { text: l.name })))),
        perm.canEdit ? el('div', { class: 'botoes-2' },
          el('button', { class: 'btn', type: 'button', text: 'Voltar etapa', disabled: idx === 0, onclick: mover(-1) }),
          el('button', { class: 'btn btn-primario', type: 'button', text: 'Avançar etapa', disabled: idx === d.lists.length - 1, onclick: mover(1) })) : null,
        el('button', { class: 'btn', type: 'button', text: perm.canEdit ? 'Editar cartão' : 'Ver detalhes', onclick: () => dialogoCartao(c, d) })));
  }

  function dialogoColuna(l, d) {
    const nome = el('input', { value: l.name, maxlength: 80 });
    const done = el('input', { type: 'checkbox', checked: !!l.isDone });
    const pos = seletor(d.lists.map((x, i) => [i, `${i + 1}ª posição`]), d.lists.findIndex((x) => x.id === l.id));
    const erro = el('p', { class: 'erro', role: 'alert' });
    abrirDialogo('Coluna', [
      campo('Nome', nome), campo('Posição no quadro', pos),
      el('div', { class: 'campo' }, el('label', {}, done, ' Cartões nesta coluna contam como concluídos')),
      erro,
    ], [
      el('button', { class: 'btn btn-perigo esq', type: 'button', text: 'Excluir coluna', onclick: async () => {
        if (!await confirmar('Excluir esta coluna? Ela precisa estar vazia.')) return;
        try { await api('DELETE', `/lists/${l.id}`); dlg.close(); rotear(); } catch (e) { erro.textContent = e.message; }
      } }),
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { class: 'btn btn-primario', type: 'button', text: 'Salvar', onclick: async () => {
        try { await api('PATCH', `/lists/${l.id}`, { name: nome.value, isDone: done.checked, index: Number(pos.value) }); dlg.close(); rotear(); }
        catch (e) { erro.textContent = e.message; }
      } }),
    ]);
  }

  function dialogoCartao(c, d, listaInicial) {
    const editavel = d.permissions.canEdit;
    const f = {
      title: el('input', { value: c?.title || '', maxlength: 200, required: true, disabled: !editavel }),
      description: el('textarea', { maxlength: 10000, value: c?.description || '', disabled: !editavel }),
      assigneeId: seletor([['', 'Sem responsável'], ...d.members.map((m) => [m.id, m.name])], c?.assigneeId),
      dueDate: el('input', { type: 'date', value: c?.dueDate || '', disabled: !editavel }),
      priority: seletor(PRIORIDADES.map((p) => [p, p]), c?.priority || 'Média'),
      phase: seletor(FASES.map((p) => [p, p || 'Sem fase']), c?.phase || ''),
      listId: seletor(d.lists.map((l) => [l.id, l.name]), c?.listId || listaInicial),
    };
    ['assigneeId', 'priority', 'phase', 'listId'].forEach((k) => { f[k].disabled = !editavel; });
    const erro = el('p', { class: 'erro', role: 'alert' });

    // Checklists: o que se edita aqui é uma cópia; só é gravada ao clicar em "Salvar cartão".
    const checklists = (c?.checklists || []).map((cl) => ({ title: cl.title, items: cl.items.map((i) => ({ text: i.text, done: i.done })) }));
    const areaCheck = el('div', { class: 'checklists' });
    // Redesenha a área e devolve o foco ao campo indicado (para o teclado não "se perder").
    const desenharChecklists = (foco) => {
      areaCheck.replaceChildren(...[
        el('div', { class: 'checklists-topo' }, el('span', { class: 'rotulo', text: 'Checklists' }),
          editavel && checklists.length < 10 ? el('button', { class: 'btn btn-fantasma', type: 'button', text: '+ Adicionar checklist',
            onclick: () => { checklists.push({ title: 'Checklist', items: [] }); desenharChecklists(`[data-cl="${checklists.length - 1}"] .checklist-titulo`); } }) : null),
        checklists.length ? null : el('p', { class: 'ajuda', text: editavel ? 'Nenhuma checklist. Use "+ Adicionar checklist" para dividir o cartão em itens.' : 'Nenhuma checklist.' }),
        checklists.map((cl, ci) => {
          const feitos = cl.items.filter((i) => i.done).length;
          const completo = cl.items.length > 0 && feitos === cl.items.length;
          const barra = el('span'); barra.style.width = pct(cl.items.length ? feitos / cl.items.length : 0);
          const novo = el('input', { class: 'novo-item', maxlength: 200, placeholder: 'Novo item', 'aria-label': `Novo item em ${cl.title}` });
          const incluir = () => {
            const t = novo.value.trim(); if (!t) return;
            if (cl.items.length >= 30) { erro.textContent = 'Cada checklist pode ter no máximo 30 itens.'; return; }
            cl.items.push({ text: t, done: false }); desenharChecklists(`[data-cl="${ci}"] .novo-item`);
          };
          novo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); incluir(); } });
          return el('section', { class: 'checklist', dataset: { cl: String(ci) }, 'aria-label': `Checklist ${cl.title}` },
            el('div', { class: 'checklist-cab' },
              editavel ? el('input', { class: 'checklist-titulo', value: cl.title, maxlength: 80, 'aria-label': 'Nome da checklist',
                oninput: (e) => { cl.title = e.target.value; } }) : el('strong', { class: 'checklist-titulo', text: cl.title }),
              el('span', { class: 'check', dataset: { completo: completo ? '1' : '0' }, text: `${feitos}/${cl.items.length}` }),
              editavel ? el('button', { class: 'btn btn-fantasma btn-perigo', type: 'button', text: 'Excluir', 'aria-label': `Excluir checklist ${cl.title}`,
                onclick: () => { checklists.splice(ci, 1); desenharChecklists(); } }) : null),
            el('div', { class: 'progresso', dataset: { completo: completo ? '1' : '0' }, role: 'img', 'aria-label': `${pct(cl.items.length ? feitos / cl.items.length : 0)} marcado` }, barra),
            el('ul', { class: 'checklist-itens' }, cl.items.map((it, ii) => el('li', { dataset: { feito: it.done ? '1' : '0' } },
              el('input', { type: 'checkbox', class: 'item-marca', checked: it.done, disabled: !editavel, 'aria-label': it.text,
                onchange: (e) => { it.done = e.target.checked; desenharChecklists(`[data-cl="${ci}"] li:nth-child(${ii + 1}) .item-marca`); } }),
              editavel ? el('input', { class: 'item-texto', value: it.text, maxlength: 200, 'aria-label': `Texto do item ${ii + 1}`,
                oninput: (e) => { it.text = e.target.value; } }) : el('span', { class: 'item-texto', text: it.text }),
              editavel ? el('button', { class: 'btn btn-fantasma', type: 'button', text: '✕', 'aria-label': `Remover item ${it.text}`,
                onclick: () => { cl.items.splice(ii, 1); desenharChecklists(`[data-cl="${ci}"] .novo-item`); } }) : null))),
            editavel && cl.items.length < 30 ? el('div', { class: 'novo-item-linha' }, novo,
              el('button', { class: 'btn', type: 'button', text: 'Adicionar', onclick: incluir })) : null);
        })].flat().filter(Boolean));
      if (foco) areaCheck.querySelector(foco)?.focus();
    };
    desenharChecklists();

    // Anexos (imagens e PDF): enviados na hora, sem esperar "Salvar cartão", porque o arquivo vai direto para o depósito.
    const TIPOS_ANEXO = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
    const areaAnexos = el('div', { class: 'anexos' });
    const entradaArquivo = el('input', { type: 'file', accept: TIPOS_ANEXO.join(','), multiple: true, hidden: true,
      onchange: (e) => { enviarArquivos([...e.target.files]); e.target.value = ''; } });
    let anexos = null; let enviando = 0; let alterouAnexos = false;
    const fmtTamanho = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);
    const paraBase64 = (arq) => new Promise((ok, falha) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1] || '');
      r.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
      r.readAsDataURL(arq);
    });
    // Na demonstração os arquivos vêm como "data:"; o navegador não abre esse formato numa aba nova, então vira um link local (blob).
    const linkLocal = async (url) => (url && url.startsWith('data:') ? URL.createObjectURL(await (await fetch(url)).blob()) : url);
    const carregarAnexos = async () => {
      try {
        const lista = await api('GET', `/cards/${c.id}/attachments`);
        anexos = await Promise.all(lista.map(async (a) => ({ ...a, url: await linkLocal(a.url), downloadUrl: await linkLocal(a.downloadUrl) })));
      } catch (e) { anexos = []; erro.textContent = e.message; }
      desenharAnexos();
    };
    const enviarArquivos = async (arquivos) => {
      if (!c || !editavel || !arquivos.length) return;
      erro.textContent = '';
      for (const arq of arquivos) {
        if (!TIPOS_ANEXO.includes(arq.type)) { erro.textContent = `"${arq.name}": envie imagem (PNG, JPG, WEBP, GIF) ou PDF.`; continue; }
        if (arq.size > 5 * 1024 * 1024) { erro.textContent = `"${arq.name}" passa de 5 MB.`; continue; }
        // Print colado com Ctrl+V chega sem nome útil ("image.png"): ganha um nome com data e hora.
        const nome = /^image\.(png|jpe?g|gif|webp)$/i.test(arq.name || '') || !arq.name
          ? `print-${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')}.${arq.type.split('/')[1].replace('jpeg', 'jpg')}` : arq.name;
        enviando++; desenharAnexos();
        try {
          await api('POST', `/cards/${c.id}/attachments`, { name: nome, data: await paraBase64(arq) });
          alterouAnexos = true;
        } catch (e) { erro.textContent = e.message; } finally { enviando--; }
      }
      await carregarAnexos();
    };
    const excluirAnexo = async (a) => {
      if (!await confirmar(`Excluir o anexo "${a.name}"? Essa ação não pode ser desfeita.`)) return;
      try { await api('DELETE', `/attachments/${a.id}`); alterouAnexos = true; await carregarAnexos(); } catch (e) { erro.textContent = e.message; }
    };
    const desenharAnexos = () => {
      areaAnexos.replaceChildren(...[
        el('div', { class: 'checklists-topo' }, el('span', { class: 'rotulo', text: 'Anexos' }),
          c && editavel ? el('button', { class: 'btn btn-fantasma', type: 'button', text: '+ Anexar arquivo', onclick: () => entradaArquivo.click() }) : null),
        !c ? el('p', { class: 'ajuda', text: 'Crie o cartão para poder anexar arquivos.' }) : null,
        c && editavel ? el('p', { class: 'ajuda', text: 'Imagens (PNG, JPG, WEBP, GIF) ou PDF, até 5 MB. Também dá para colar um print com Ctrl+V ou arrastar o arquivo para esta janela.' }) : null,
        enviando ? el('p', { class: 'ajuda', role: 'status', text: 'Enviando arquivo…' }) : null,
        c && anexos === null ? el('p', { class: 'ajuda', text: 'Carregando anexos…' }) : null,
        c && anexos && !anexos.length && !enviando ? el('p', { class: 'ajuda', text: 'Nenhum anexo.' }) : null,
        c && anexos && anexos.length ? el('ul', { class: 'anexos-lista' }, anexos.map((a) => {
          const imagem = a.type.startsWith('image/');
          return el('li', {},
            el('a', { class: 'anexo-miniatura', href: a.url, target: '_blank', rel: 'noopener', 'aria-label': `Abrir ${a.name}` },
              imagem ? el('img', { src: a.url, alt: '', loading: 'lazy' }) : el('span', { text: 'PDF' })),
            el('div', { class: 'anexo-info' },
              el('span', { class: 'anexo-nome', text: a.name, title: a.name }),
              el('span', { class: 'ajuda', text: [fmtTamanho(a.size), a.authorName, fmtHora(a.createdAt)].filter(Boolean).join(' · ') }),
              el('span', { class: 'anexo-acoes' },
                el('a', { class: 'btn btn-fantasma', href: a.url, target: '_blank', rel: 'noopener', text: 'Abrir' }),
                el('a', { class: 'btn btn-fantasma', href: a.downloadUrl, download: a.name, text: 'Baixar' }),
                editavel ? el('button', { class: 'btn btn-fantasma btn-perigo', type: 'button', text: 'Excluir', 'aria-label': `Excluir anexo ${a.name}`,
                  onclick: () => excluirAnexo(a) }) : null)));
        })) : null,
        entradaArquivo,
      ].filter(Boolean));
    };
    desenharAnexos();
    if (c) {
      carregarAnexos();
      // Colar print (Ctrl+V) e arrastar arquivo valem enquanto a janela do cartão estiver aberta.
      const aoColar = (e) => {
        const arquivos = [...(e.clipboardData?.files || [])].filter((f) => TIPOS_ANEXO.includes(f.type));
        if (!arquivos.length || !editavel) return;
        e.preventDefault(); enviarArquivos(arquivos);
      };
      const aoArrastar = (e) => { if (editavel && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); areaAnexos.classList.add('alvo'); } };
      const aoSoltar = (e) => {
        areaAnexos.classList.remove('alvo');
        if (!editavel || !e.dataTransfer?.files?.length) return;
        e.preventDefault(); enviarArquivos([...e.dataTransfer.files]);
      };
      document.addEventListener('paste', aoColar);
      dlg.addEventListener('dragover', aoArrastar);
      dlg.addEventListener('drop', aoSoltar);
      dlg.addEventListener('close', () => {
        document.removeEventListener('paste', aoColar);
        dlg.removeEventListener('dragover', aoArrastar);
        dlg.removeEventListener('drop', aoSoltar);
        if (alterouAnexos) rotear(); // atualiza o contador de anexos no quadro
      }, { once: true });
    }

    const corpo = [
      campo('Título', f.title), campo('Descrição', f.description),
      el('div', { class: 'grade-2' }, campo('Coluna', f.listId), campo('Responsável', f.assigneeId),
        campo('Prazo', f.dueDate), campo('Prioridade', f.priority)),
      campo('Fase do projeto', f.phase),
      areaCheck,
      areaAnexos,
      c ? el('p', { class: 'ajuda', text: `Última alteração em ${fmtHora(c.updatedAt)}` }) : null,
      erro,
    ];
    const salvar = async () => {
      erro.textContent = '';
      const dados = { title: f.title.value, description: f.description.value, assigneeId: f.assigneeId.value ? Number(f.assigneeId.value) : null,
        dueDate: f.dueDate.value || null, priority: f.priority.value, phase: f.phase.value };
      areaCheck.querySelectorAll('.checklist').forEach((sec) => {
        const t = sec.querySelector('.novo-item')?.value.trim();
        if (t) checklists[Number(sec.dataset.cl)].items.push({ text: t, done: false });
      });
      dados.checklists = checklists;
      try {
        if (c) {
          await api('PATCH', `/cards/${c.id}`, dados);
          if (Number(f.listId.value) !== c.listId) await api('PATCH', `/cards/${c.id}/move`, { listId: Number(f.listId.value), index: 100000 });
        } else {
          await api('POST', `/boards/${d.board.id}/cards`, { ...dados, listId: Number(f.listId.value) });
        }
        dlg.close(); rotear();
      } catch (e) { erro.textContent = e.message; }
    };
    const excluir = async () => {
      if (!await confirmar('Excluir este cartão? Essa ação não pode ser desfeita.')) return;
      try { await api('DELETE', `/cards/${c.id}`); dlg.close(); rotear(); } catch (e) { erro.textContent = e.message; }
    };
    abrirDialogo(c ? (editavel ? 'Editar cartão' : 'Cartão') : 'Novo cartão', corpo, editavel ? [
      c ? el('button', { class: 'btn btn-perigo esq', type: 'button', text: 'Excluir cartão', onclick: excluir }) : null,
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { class: 'btn btn-primario', type: 'button', text: c ? 'Salvar cartão' : 'Criar cartão', onclick: salvar }),
    ] : [el('button', { class: 'btn', type: 'button', text: 'Fechar', onclick: () => dlg.close() })]);
    f.title.focus();
  }

  // ---------- tela: desempenho ----------
  async function telaDesempenho() {
    const d = await api('GET', '/dashboard');
    const atrasados = d.boards.filter((b) => b.farol === 'Atrasado').length;
    const pctGeral = d.totals.total ? d.totals.done / d.totals.total : 0;
    const kpi = (valor, rotulo, alerta) => el('div', { class: 'kpi', dataset: { alerta: alerta ? '1' : '0' } }, el('strong', { text: valor }), el('span', { text: rotulo }));
    const maxSemana = Math.max(1, ...d.throughput.map((t) => t.count));

    const linhasProjetos = d.boards.map((b) => {
      const barra = el('span'); barra.style.width = pct(b.pct);
      return el('tr', {},
        el('td', {}, el('a', { href: `#/quadro/${b.id}`, text: `${b.code} ${b.name}` })),
        el('td', { text: b.ownerName || '' }),
        el('td', { text: b.priority }),
        el('td', {}, el('span', { class: 'farol', dataset: { f: b.farol }, text: b.farol })),
        el('td', { class: 'num' }, el('div', { class: 'pct-celula' }, el('div', { class: 'progresso', 'aria-hidden': 'true' }, barra), pct(b.pct))),
        el('td', { class: 'num', text: `${b.done}/${b.total}` }),
        el('td', { class: 'num', text: String(b.overdue) }),
        el('td', { text: fmtData(b.dueDate) }));
    });
    const linhasPessoas = d.people.map((p) => el('tr', {},
      el('td', { text: p.name }), el('td', { class: 'num', text: String(p.open) }), el('td', { class: 'num', text: String(p.overdue) }),
      el('td', { class: 'num', text: String(p.done30) }), el('td', { class: 'num', text: p.done30 ? pct(p.onTime30 / p.done30) : '' })));

    app.replaceChildren(
      el('div', { class: 'cabecalho' }, el('div', {}, el('h1', { text: 'Desempenho' }),
        el('p', { text: `Situação em ${fmtData(d.today)}. Farol segue a regra da planilha: atenção quando o prazo decorrido supera o avanço em mais de 20 pontos.` }))),
      el('div', { class: 'kpis' },
        kpi(String(d.boards.length), 'projetos ativos'),
        kpi(pct(pctGeral), 'das atividades concluídas'),
        kpi(String(d.totals.overdue), 'atividades atrasadas', d.totals.overdue > 0),
        kpi(String(atrasados), 'projetos atrasados', atrasados > 0)),
      el('section', { class: 'secao' }, el('h2', { text: 'Projetos' }),
        d.boards.length ? el('div', { class: 'rolagem' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Projeto', 'Responsável', 'Prioridade', 'Farol', '% concluído', 'Atividades', 'Atrasadas', 'Fim previsto']
            .map((h, i) => el('th', { class: i >= 4 && i <= 6 ? 'num' : null, text: h })))),
          el('tbody', {}, linhasProjetos))) : el('p', { class: 'ajuda', text: 'Nenhum projeto visível para você.' })),
      el('section', { class: 'secao' }, el('h2', { text: 'Entregas por semana (últimas 8)' }),
        el('div', { class: 'barras', role: 'img', 'aria-label': d.throughput.map((t) => `${fmtData(t.weekEnding)}: ${t.count}`).join(', ') },
          d.throughput.map((t) => { const i = el('i'); i.style.height = `${(t.count / maxSemana) * 100}%`;
            return el('div', {}, el('b', { text: String(t.count) }), i, el('span', { text: fmtData(t.weekEnding).slice(0, 5) })); }))),
      el('section', { class: 'secao' }, el('h2', { text: 'Pessoas' }),
        linhasPessoas.length ? el('div', { class: 'rolagem' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Responsável', 'Em aberto', 'Atrasadas', 'Concluídas em 30 dias', 'No prazo']
            .map((h, i) => el('th', { class: i ? 'num' : null, text: h })))),
          el('tbody', {}, linhasPessoas))) : el('p', { class: 'ajuda', text: 'Atribua responsáveis aos cartões para ver o desempenho por pessoa.' })),
    );
  }

  // ---------- tela: usuários (admin) ----------
  async function telaUsuarios() {
    const users = await api('GET', '/users');
    const linha = (u) => {
      const papel = seletor(Object.entries(ROLES), u.role);
      papel.setAttribute('aria-label', `Perfil de ${u.name}`);
      papel.addEventListener('change', tentar(async () => { await api('PATCH', `/users/${u.id}`, { role: papel.value }); aviso('Perfil alterado.'); rotear(); }));
      const bloqueado = u.lockedUntil && u.lockedUntil > Date.now();
      return el('tr', {},
        el('td', { text: u.name }), el('td', { text: u.email }), el('td', {}, papel),
        el('td', { text: !u.active ? 'Inativo' : bloqueado ? 'Bloqueado' : u.mustChangePassword ? 'Aguardando 1º acesso' : 'Ativo' }),
        el('td', { text: fmtHora(u.lastLoginAt) }),
        el('td', {},
          el('button', { class: 'btn', type: 'button', text: 'Redefinir senha', onclick: tentar(async () => {
            if (!await confirmar(`Gerar nova senha temporária para ${u.name}? As sessões abertas serão encerradas.`)) return;
            const r = await api('POST', `/users/${u.id}/reset-password`); mostrarSenhaTemporaria(u.name, r.temporaryPassword); rotear();
          }) }), ' ',
          bloqueado ? el('button', { class: 'btn', type: 'button', text: 'Desbloquear', onclick: tentar(async () => { await api('POST', `/users/${u.id}/unlock`); rotear(); }) }) : null, ' ',
          el('button', { class: u.active ? 'btn btn-perigo' : 'btn', type: 'button', text: u.active ? 'Desativar' : 'Reativar', onclick: tentar(async () => {
            await api('PATCH', `/users/${u.id}`, { active: !u.active }); aviso(u.active ? 'Usuário desativado.' : 'Usuário reativado.'); rotear();
          }) })));
    };
    app.replaceChildren(
      el('div', { class: 'cabecalho' },
        el('div', {}, el('h1', { text: 'Usuários' }), el('p', { text: 'Não há cadastro aberto: só o administrador cria acessos. Desative quem sair da empresa no mesmo dia.' })),
        el('button', { class: 'btn btn-primario', type: 'button', text: 'Novo usuário', onclick: dialogoUsuario })),
      el('section', { class: 'secao' }, el('div', { class: 'rolagem' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Nome', 'E-mail', 'Perfil', 'Situação', 'Último acesso', 'Ações'].map((h) => el('th', { text: h })))),
        el('tbody', {}, users.map(linha))))),
      el('section', { class: 'secao' }, el('h2', { text: 'Perfis' }),
        el('p', { class: 'ajuda', text: 'Administrador: tudo, inclusive usuários e auditoria. Gestor: cria projetos e gerencia os quadros de que participa. Membro: cria e move cartões nos quadros de que participa. Leitor: apenas visualiza.' })),
    );
  }

  function dialogoUsuario() {
    const nome = el('input', { maxlength: 120, autocomplete: 'off' });
    const email = el('input', { type: 'email', maxlength: 200, autocomplete: 'off' });
    const papel = seletor(Object.entries(ROLES), 'membro');
    const erro = el('p', { class: 'erro', role: 'alert' });
    abrirDialogo('Novo usuário', [campo('Nome completo', nome), campo('E-mail corporativo', email), campo('Perfil', papel), erro], [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { class: 'btn btn-primario', type: 'button', text: 'Criar usuário', onclick: async () => {
        try {
          const r = await api('POST', '/users', { name: nome.value, email: email.value, role: papel.value });
          mostrarSenhaTemporaria(nome.value, r.temporaryPassword); telaUsuarios();
        } catch (e) { erro.textContent = e.message; }
      } }),
    ]);
    nome.focus();
  }

  // ---------- tela: auditoria (admin) ----------
  async function telaAuditoria() {
    const rows = await api('GET', '/dashboard/audit?limit=300');
    app.replaceChildren(
      el('div', { class: 'cabecalho' }, el('div', {}, el('h1', { text: 'Auditoria' }),
        el('p', { text: 'Últimos 300 eventos: acessos, falhas de login, bloqueios, alterações de usuários, projetos e cartões.' }))),
      el('section', { class: 'secao' }, el('div', { class: 'rolagem' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Data e hora', 'Usuário', 'Ação', 'Objeto', 'IP', 'Detalhes'].map((h) => el('th', { text: h })))),
        el('tbody', {}, rows.map((r) => el('tr', {},
          el('td', { text: fmtHora(r.at) }), el('td', { text: r.userEmail || '' }), el('td', { text: r.action }),
          el('td', { text: r.entity ? `${r.entity} ${r.entityId ?? ''}` : '' }), el('td', { text: r.ip || '' }),
          el('td', { class: 'ajuda', text: r.details || '' }))))))),
    );
  }

  // ---------- alterar senha / sair ----------
  function dialogoSenha() {
    const atual = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 128 });
    const nova = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
    const conf = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
    const erro = el('p', { class: 'erro', role: 'alert' });
    abrirDialogo('Alterar senha', [campo('Senha atual', atual), campo('Nova senha', nova, 'Mínimo de 12 caracteres, combinando 3 tipos: minúsculas, maiúsculas, números e símbolos.'),
      campo('Confirme a nova senha', conf), el('p', { class: 'ajuda', text: 'Suas outras sessões abertas serão encerradas.' }), erro], [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }),
      el('button', { class: 'btn btn-primario', type: 'button', text: 'Alterar senha', onclick: async () => {
        if (nova.value !== conf.value) { erro.textContent = 'A confirmação não confere com a nova senha.'; return; }
        try { await api('POST', '/auth/change-password', { currentPassword: atual.value, newPassword: nova.value }); dlg.close(); aviso('Senha alterada.'); }
        catch (e) { erro.textContent = e.message; }
      } }),
    ]);
    atual.focus();
  }

  document.getElementById('btn-senha').addEventListener('click', dialogoSenha);
  document.getElementById('btn-sair').addEventListener('click', async () => {
    try { await api('POST', '/auth/logout', {}); } finally { location.replace('/login'); }
  });

  // ---------- início ----------
  (async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!r.ok) { location.replace('/login'); return; }
      const d = await r.json();
      state.me = d.user; state.csrf = d.csrfToken;
      if (state.me.mustChangePassword) { location.replace('/login?trocar=1'); return; }
      document.getElementById('nome-usuario').textContent = `${state.me.name} (${ROLES[state.me.role]})`;
      await carregarDiretorio();
      window.addEventListener('hashchange', rotear);
      rotear();
    } catch { location.replace('/login'); }
  })();
})();
