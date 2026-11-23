'use strict';
// Testes de integração dos controles de segurança. Rodar: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.MAX_FAILED_LOGINS = '3';

const app = require('../src/server');
const db = require('../src/db');
const { hashPassword } = require('../src/security/password');

let server; let base;
const ADMIN = { email: 'admin@empresa.com.br', password: 'Temp#Admin-2026x' };

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, { csrf = true, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; }
    if (csrf && this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = sc.match(/^((?:__Host-)?sid)=([^;]*)/); if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : ''; }
    let data = null; try { data = await r.json(); } catch { /* */ }
    return { status: r.status, data, headers: r.headers };
  }
  async login(email, password) {
    const r = await this.req('POST', '/api/auth/login', { email, password }, { csrf: false });
    if (r.data && r.data.csrfToken) this.csrf = r.data.csrfToken;
    return r;
  }
}

before(async () => {
  const now = Date.now();
  db.prepare(`INSERT INTO users (email, name, role, password_hash, must_change_password, password_changed_at, created_at)
    VALUES (?, 'Admin Teste', 'admin', ?, 1, ?, ?)`).run(ADMIN.email, await hashPassword(ADMIN.password), now, now);
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('cabeçalhos de segurança presentes', async () => {
  const r = await fetch(base + '/login');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('API exige autenticação', async () => {
  const c = new Client();
  assert.equal((await c.req('GET', '/api/boards')).status, 401);
  const home = await c.req('GET', '/');
  assert.equal(home.status, 302);
});

test('mensagem de login não revela se o e-mail existe', async () => {
  const c = new Client();
  const a = await c.login('ninguem@empresa.com.br', 'qualquer-coisa');
  const b = await c.login(ADMIN.email, 'senha-errada-123');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
  db.prepare('UPDATE users SET failed_attempts = 0 WHERE email = ?').run(ADMIN.email);
});

let admin;
test('primeiro acesso exige troca de senha e aplica política', async () => {
  admin = new Client();
  const r = await admin.login(ADMIN.email, ADMIN.password);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.mustChangePassword, true);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.equal((await admin.req('GET', '/api/boards')).status, 403);
  const fraca = await admin.req('POST', '/api/auth/change-password', { currentPassword: ADMIN.password, newPassword: 'curta' });
  assert.equal(fraca.status, 400);
  const ok = await admin.req('POST', '/api/auth/change-password', { currentPassword: ADMIN.password, newPassword: 'Nova-Senha#Forte2026' });
  assert.equal(ok.status, 200);
  assert.equal((await admin.req('GET', '/api/boards')).status, 200);
});

test('CSRF: rejeita sem token, com token errado e sem JSON', async () => {
  assert.equal((await admin.req('POST', '/api/boards', { name: 'X1' }, { csrf: false })).status, 403);
  const wrong = await admin.req('POST', '/api/boards', { name: 'X1' }, { csrf: false, headers: { 'X-CSRF-Token': 'abc' } });
  assert.equal(wrong.status, 403);
  const form = await admin.req('POST', '/api/boards', 'name=X1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const origem = await admin.req('POST', '/api/boards', { name: 'X1' }, { headers: { Origin: 'https://atacante.example' } });
  assert.equal(origem.status, 403);
});

let membro; let leitor; let boardId; let listIds; let cardId; let membroId;
test('fluxo de quadro, papéis e isolamento entre usuários', async () => {
  const m = await admin.req('POST', '/api/users', { email: 'membro@empresa.com.br', name: 'Maria Membro', role: 'membro' });
  assert.equal(m.status, 201); assert.ok(m.data.temporaryPassword.length >= 16);
  membroId = m.data.id;
  const l = await admin.req('POST', '/api/users', { email: 'leitor@empresa.com.br', name: 'Lucas Leitor', role: 'leitor' });
  membro = new Client(); await membro.login('membro@empresa.com.br', m.data.temporaryPassword);
  await membro.req('POST', '/api/auth/change-password', { currentPassword: m.data.temporaryPassword, newPassword: 'Rota#Azul-2026!x' });
  leitor = new Client(); await leitor.login('leitor@empresa.com.br', l.data.temporaryPassword);
  await leitor.req('POST', '/api/auth/change-password', { currentPassword: l.data.temporaryPassword, newPassword: 'Caixa#Verde-2026!y' });

  const b = await admin.req('POST', '/api/boards', { name: 'Roteirizador', startDate: '2026-01-01', dueDate: '2026-12-31' });
  assert.equal(b.status, 201); boardId = b.data.id;
  assert.equal((await membro.req('GET', `/api/boards/${boardId}`)).status, 404, 'não-membro não vê o quadro');
  assert.equal((await membro.req('POST', '/api/boards', { name: 'Proibido' })).status, 403, 'membro não cria quadro');

  await admin.req('PUT', `/api/boards/${boardId}/members`, { userIds: [m.data.id, l.data.id] });
  const view = await membro.req('GET', `/api/boards/${boardId}`);
  assert.equal(view.status, 200); listIds = view.data.lists.map((x) => x.id);

  const c = await membro.req('POST', `/api/boards/${boardId}/cards`, { listId: listIds[0], title: '<img src=x onerror=alert(1)>' });
  assert.equal(c.status, 201); cardId = c.data.id;
  assert.equal((await leitor.req('POST', `/api/boards/${boardId}/cards`, { listId: listIds[0], title: 'x' })).status, 403, 'leitor não edita');
  assert.equal((await leitor.req('PATCH', `/api/cards/${cardId}`, { title: 'x' })).status, 403);

  const mv = await membro.req('PATCH', `/api/cards/${cardId}/move`, { listId: listIds[3], index: 0 });
  assert.equal(mv.status, 200);
  const after = await membro.req('GET', `/api/boards/${boardId}`);
  assert.equal(after.data.board.done, 1);
  assert.equal(after.data.cards[0].title, '<img src=x onerror=alert(1)>', 'texto armazenado sem execução (front usa textContent)');
});

test('validação rejeita campos desconhecidos e IDs inválidos', async () => {
  assert.equal((await admin.req('PATCH', `/api/cards/${cardId}`, { title: 'ok', board_id: 999 })).status, 400);
  assert.equal((await admin.req('GET', '/api/boards/1%20OR%201=1')).status, 400);
  assert.equal((await admin.req('POST', '/api/boards', { name: 'A', dueDate: '2026-13-45' })).status, 400);
});

test('checklists: membro grava e marca, leitor não altera, formato inválido é recusado', async () => {
  const cl = [{ title: 'Testes', items: [{ text: 'Rodar piloto', done: true }, { text: 'Validar rotas', done: false }, { text: '   ', done: false }] }];
  assert.equal((await membro.req('PATCH', `/api/cards/${cardId}`, { checklists: cl })).status, 200);
  const view = await membro.req('GET', `/api/boards/${boardId}`);
  const card = view.data.cards.find((x) => x.id === cardId);
  assert.deepEqual(card.checklists, [{ title: 'Testes', items: [{ text: 'Rodar piloto', done: true }, { text: 'Validar rotas', done: false }] }],
    'item sem texto é descartado');
  assert.equal((await leitor.req('PATCH', `/api/cards/${cardId}`, { checklists: [] })).status, 403, 'leitor não altera checklist');
  assert.equal((await membro.req('PATCH', `/api/cards/${cardId}`, { checklists: [{ title: 'x', items: 'não é lista' }] })).status, 400);
  assert.equal((await membro.req('PATCH', `/api/cards/${cardId}`, { checklists: Array.from({ length: 11 }, () => ({ title: 'x', items: [] })) })).status, 400,
    'no máximo 10 checklists');
  const novo = await membro.req('POST', `/api/boards/${boardId}/cards`, { listId: listIds[0], title: 'Com checklist', checklists: [{ title: '', items: [] }] });
  assert.equal(novo.status, 201);
  const v2 = await membro.req('GET', `/api/boards/${boardId}`);
  assert.deepEqual(v2.data.cards.find((x) => x.id === novo.data.id).checklists, [{ title: 'Checklist', items: [] }], 'nome vazio vira "Checklist"');
});

test('anexos: membro envia, leitor só vê, tipo real conferido, limite de 5 MB', async () => {
  // PNG mínimo válido (1x1)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const env = await membro.req('POST', `/api/cards/${cardId}/attachments`, { name: 'print da tela.png', data: png.toString('base64') });
  assert.equal(env.status, 201); const anexoId = env.data.id;

  const lista = await leitor.req('GET', `/api/cards/${cardId}/attachments`);
  assert.equal(lista.status, 200, 'leitor vê a lista');
  assert.equal(lista.data.length, 1);
  assert.equal(lista.data[0].name, 'print da tela.png');
  assert.equal(lista.data[0].type, 'image/png');

  const baixar = await fetch(`${base}/api/attachments/${anexoId}?download=1`, { headers: { Cookie: leitor.cookie } });
  assert.equal(baixar.status, 200, 'leitor baixa');
  assert.equal(baixar.headers.get('content-type'), 'image/png');
  assert.match(baixar.headers.get('content-disposition'), /^attachment;/);
  assert.equal(baixar.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await baixar.arrayBuffer()), png, 'devolve exatamente o arquivo enviado');

  assert.equal((await leitor.req('POST', `/api/cards/${cardId}/attachments`, { name: 'x.png', data: png.toString('base64') })).status, 403, 'leitor não envia');
  assert.equal((await leitor.req('DELETE', `/api/attachments/${anexoId}`, {})).status, 403, 'leitor não exclui');

  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  assert.equal((await membro.req('POST', `/api/cards/${cardId}/attachments`, { name: 'falso.png', data: html })).status, 400, 'HTML disfarçado de imagem é recusado');
  const grande = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  assert.equal((await membro.req('POST', `/api/cards/${cardId}/attachments`, { name: 'grande.png', data: grande })).status, 413, 'acima de 5 MB é recusado');

  const quadro = await membro.req('GET', `/api/boards/${boardId}`);
  assert.equal(quadro.data.cards.find((x) => x.id === cardId).attachmentCount, 1, 'contador no quadro');

  assert.equal((await membro.req('DELETE', `/api/attachments/${anexoId}`, {})).status, 200);
  assert.equal((await membro.req('GET', `/api/cards/${cardId}/attachments`)).data.length, 0);

  // Excluir o cartão apaga os anexos dele
  const c2 = await membro.req('POST', `/api/boards/${boardId}/cards`, { listId: listIds[0], title: 'Cartão com anexo' });
  await membro.req('POST', `/api/cards/${c2.data.id}/attachments`, { name: 'a.png', data: png.toString('base64') });
  assert.equal((await membro.req('DELETE', `/api/cards/${c2.data.id}`, {})).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ?').get(c2.data.id).n, 0);
});

test('arquivados: admin consulta (somente leitura) e desarquiva; demais não veem', async () => {
  const q = await admin.req('POST', '/api/boards', { name: 'Projeto para arquivar' });
  const qid = q.data.id;
  await admin.req('PUT', `/api/boards/${qid}/members`, { userIds: [membroId] });
  const v = await admin.req('GET', `/api/boards/${qid}`);
  const c = await membro.req('POST', `/api/boards/${qid}/cards`, { listId: v.data.lists[0].id, title: 'Cartão antigo' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  await membro.req('POST', `/api/cards/${c.data.id}/attachments`, { name: 'evidencia.png', data: png.toString('base64') });

  assert.equal((await admin.req('DELETE', `/api/boards/${qid}`, {})).status, 200, 'arquiva');
  assert.ok(!(await admin.req('GET', '/api/boards')).data.some((b) => b.id === qid), 'some da lista de quadros');

  const lista = await admin.req('GET', '/api/boards/archived');
  assert.equal(lista.status, 200);
  const item = lista.data.find((b) => b.id === qid);
  assert.ok(item, 'aparece em arquivados'); assert.equal(item.total, 1);

  const ver = await admin.req('GET', `/api/boards/${qid}`);
  assert.equal(ver.status, 200, 'admin abre o arquivado');
  assert.equal(ver.data.board.archived, true);
  assert.deepEqual(ver.data.permissions, { canEdit: false, canManage: false }, 'somente leitura');
  assert.equal(ver.data.cards[0].title, 'Cartão antigo', 'dados preservados');
  assert.equal((await admin.req('GET', `/api/cards/${c.data.id}/attachments`)).data.length, 1, 'anexos preservados');
  assert.equal((await admin.req('PATCH', `/api/cards/${c.data.id}`, { title: 'x' })).status, 404, 'nada pode ser alterado');

  assert.equal((await membro.req('GET', '/api/boards/archived')).status, 403, 'membro não vê a lista');
  assert.equal((await membro.req('GET', `/api/boards/${qid}`)).status, 404, 'membro não abre o arquivado');
  assert.equal((await membro.req('POST', `/api/boards/${qid}/unarchive`, {})).status, 403, 'membro não desarquiva');

  assert.equal((await admin.req('POST', `/api/boards/${qid}/unarchive`, {})).status, 200, 'admin desarquiva');
  const depois = await membro.req('GET', `/api/boards/${qid}`);
  assert.equal(depois.status, 200, 'volta para os membros');
  assert.equal(depois.data.board.archived, false);
  assert.equal(depois.data.permissions.canEdit, true, 'volta a ser editável');
  assert.equal((await admin.req('POST', `/api/boards/${qid}/unarchive`, {})).status, 404, 'não desarquiva o que não está arquivado');
});

test('somente admin acessa usuários e auditoria', async () => {
  assert.equal((await membro.req('GET', '/api/users')).status, 403);
  assert.equal((await membro.req('GET', '/api/dashboard/audit')).status, 403);
  const a = await admin.req('GET', '/api/dashboard/audit');
  assert.ok(a.data.some((r) => r.action === 'login.sucesso'));
  assert.ok(!JSON.stringify(a.data).includes('2026!'), 'auditoria não contém senhas');
});

test('bloqueio de conta após tentativas falhas', async () => {
  const c = new Client();
  for (let i = 0; i < 3; i++) await c.login('leitor@empresa.com.br', 'errada-' + i);
  const r = await c.login('leitor@empresa.com.br', 'Caixa#Verde-2026!y');
  assert.equal(r.status, 401, 'senha correta é recusada durante o bloqueio');
  const row = db.prepare("SELECT locked_until FROM users WHERE email = 'leitor@empresa.com.br'").get();
  assert.ok(row.locked_until > Date.now());
});

test('desativar usuário encerra sessões; logout invalida a sessão', async () => {
  const id = db.prepare("SELECT id FROM users WHERE email = 'membro@empresa.com.br'").get().id;
  await admin.req('PATCH', `/api/users/${id}`, { active: false });
  assert.equal((await membro.req('GET', '/api/boards')).status, 401);
  const copia = admin.cookie;
  await admin.req('POST', '/api/auth/logout', {});
  const reuse = await fetch(base + '/api/boards', { headers: { Cookie: copia } });
  assert.equal(reuse.status, 401, 'cookie antigo não funciona após logout');
});

test('banco guarda só hash de senha e de token de sessão', () => {
  const u = db.prepare('SELECT password_hash FROM users LIMIT 1').get();
  assert.match(u.password_hash, /^scrypt\$/);
  const s = db.prepare('SELECT token_hash FROM sessions LIMIT 1').get();
  if (s) assert.match(s.token_hash, /^[0-9a-f]{64}$/);
});
