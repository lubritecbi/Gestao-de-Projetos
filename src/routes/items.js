'use strict';
// Rotas de listas e cartões endereçados pelo próprio ID (a autorização sempre verifica o quadro dono).
const express = require('express');
const db = require('../db');
const { audit } = require('../audit');
const { boardAccess, assertEdit, HttpError } = require('../access');
const { z, text, id, parse } = require('../validate');
const { cardFields } = require('./boards');
const { MAX_ANEXO, tipoReal, nomeArquivo, disposicao } = require('../files');

const router = express.Router();

function reorder(table, scopeCol, scopeId, itemId, index) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE ${scopeCol} = ? AND id <> ? ORDER BY position`).all(scopeId, itemId);
  const at = Math.max(0, Math.min(index, rows.length));
  rows.splice(at, 0, { id: itemId });
  const upd = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  rows.forEach((r, i) => upd.run(i, r.id));
}

// ---------- Listas ----------
function loadList(req) {
  const listId = parse(id, req.params.id);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) throw new HttpError(404, 'Coluna não encontrada.');
  const access = boardAccess(req.user, list.board_id);
  assertEdit(access);
  return list;
}

router.patch('/lists/:id', (req, res, next) => {
  try {
    const list = loadList(req);
    const d = parse(z.object({ name: text(80, 1).optional(), isDone: z.boolean().optional(),
      index: z.number().int().min(0).max(1000).optional() }).strict(), req.body);
    db.transaction(() => {
      if (d.name !== undefined) db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(d.name, list.id);
      if (d.isDone !== undefined && Number(d.isDone) !== list.is_done) {
        db.prepare('UPDATE lists SET is_done = ? WHERE id = ?').run(Number(d.isDone), list.id);
        db.prepare('UPDATE cards SET completed_at = ? WHERE list_id = ?').run(d.isDone ? Date.now() : null, list.id);
      }
      if (d.index !== undefined) reorder('lists', 'board_id', list.board_id, list.id, d.index);
    })();
    audit(req, 'lista.alterada', { entity: 'list', entityId: list.id, details: d });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/lists/:id', (req, res, next) => {
  try {
    const list = loadList(req);
    const n = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE list_id = ?').get(list.id).n;
    if (n > 0) throw new HttpError(400, 'Mova ou exclua os cartões antes de excluir a coluna.');
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
    audit(req, 'lista.excluida', { entity: 'list', entityId: list.id, details: { name: list.name } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Cartões ----------
function loadCard(req) {
  const cardId = parse(id, req.params.id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) throw new HttpError(404, 'Cartão não encontrado.');
  const access = boardAccess(req.user, card.board_id);
  assertEdit(access);
  return card;
}

const updateSchema = z.object(cardFields).partial().strict();

router.patch('/cards/:id', (req, res, next) => {
  try {
    const card = loadCard(req);
    const d = parse(updateSchema, req.body);
    if (d.assigneeId && !db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?').get(card.board_id, d.assigneeId)) {
      throw new HttpError(400, 'O responsável precisa ser membro do quadro.');
    }
    const map = { title: 'title', description: 'description', assigneeId: 'assignee_id', dueDate: 'due_date', priority: 'priority', phase: 'phase' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col} = ?`); vals.push(d[k]); }
    if (d.checklists !== undefined) { sets.push('checklists = ?'); vals.push(JSON.stringify(d.checklists)); }
    if (sets.length) {
      db.prepare(`UPDATE cards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), card.id);
      audit(req, 'cartao.alterado', { entity: 'card', entityId: card.id, details: Object.keys(d) });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/cards/:id/move', (req, res, next) => {
  try {
    const card = loadCard(req);
    const d = parse(z.object({ listId: id, index: z.number().int().min(0).max(100000) }).strict(), req.body);
    const target = db.prepare('SELECT * FROM lists WHERE id = ? AND board_id = ?').get(d.listId, card.board_id);
    if (!target) throw new HttpError(400, 'Coluna inválida para este quadro.');
    const from = db.prepare('SELECT * FROM lists WHERE id = ?').get(card.list_id);
    db.transaction(() => {
      const completed = target.is_done ? (from.is_done ? card.completed_at : Date.now()) : null;
      db.prepare('UPDATE cards SET list_id = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(target.id, completed, Date.now(), card.id);
      reorder('cards', 'list_id', target.id, card.id, d.index);
      if (from.id !== target.id) {
        const rest = db.prepare('SELECT id FROM cards WHERE list_id = ? ORDER BY position').all(from.id);
        const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
        rest.forEach((r, i) => upd.run(i, r.id));
      }
    })();
    if (from.id !== target.id) {
      audit(req, 'cartao.movido', { entity: 'card', entityId: card.id, details: { de: from.name, para: target.name } });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Anexos ----------
// Ver/baixar: qualquer pessoa com acesso ao quadro. Enviar/excluir: quem edita o quadro.
function cardForView(req) {
  const cardId = parse(id, req.params.id);
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) throw new HttpError(404, 'Cartão não encontrado.');
  boardAccess(req.user, card.board_id, { verArquivado: true });
  return card;
}

router.get('/cards/:id/attachments', (req, res, next) => {
  try {
    const card = cardForView(req);
    const rows = db.prepare(`SELECT a.id, a.name, a.mime AS type, a.size, a.created_at AS createdAt, u.name AS authorName
      FROM attachments a LEFT JOIN users u ON u.id = a.created_by WHERE a.card_id = ? ORDER BY a.created_at, a.id`).all(card.id);
    res.json(rows.map((a) => ({ ...a, url: `/api/attachments/${a.id}`, downloadUrl: `/api/attachments/${a.id}?download=1` })));
  } catch (e) { next(e); }
});

router.post('/cards/:id/attachments', (req, res, next) => {
  try {
    const card = loadCard(req);
    const d = parse(z.object({ name: z.string().max(600), data: z.string().max(7 * 1024 * 1024) }).strict(), req.body);
    const bytes = Buffer.from(d.data, 'base64');
    if (!bytes.length) throw new HttpError(400, 'Arquivo vazio.');
    if (bytes.length > MAX_ANEXO) throw new HttpError(413, 'O arquivo passa de 5 MB.');
    const tipo = tipoReal(bytes);
    if (!tipo) throw new HttpError(400, 'Tipo de arquivo não aceito. Envie imagem (PNG, JPG, WEBP, GIF) ou PDF.');
    const name = nomeArquivo(d.name);
    const info = db.prepare(`INSERT INTO attachments (card_id, board_id, name, mime, size, data, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(card.id, card.board_id, name, tipo, bytes.length, bytes, req.user.id, Date.now());
    audit(req, 'cartao.anexo_incluido', { entity: 'card', entityId: card.id, details: { boardId: card.board_id, arquivo: name } });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});

router.get('/attachments/:id', (req, res, next) => {
  try {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(parse(id, req.params.id));
    if (!a) throw new HttpError(404, 'Anexo não encontrado.');
    boardAccess(req.user, a.board_id, { verArquivado: true });
    res.set('Content-Type', a.mime);
    res.set('Content-Disposition', disposicao(req.query.download ? 'attachment' : 'inline', a.name));
    res.send(a.data);
  } catch (e) { next(e); }
});

router.delete('/attachments/:id', (req, res, next) => {
  try {
    const a = db.prepare('SELECT id, card_id, board_id, name FROM attachments WHERE id = ?').get(parse(id, req.params.id));
    if (!a) throw new HttpError(404, 'Anexo não encontrado.');
    assertEdit(boardAccess(req.user, a.board_id));
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    audit(req, 'cartao.anexo_excluido', { entity: 'card', entityId: a.card_id, details: { boardId: a.board_id, arquivo: a.name } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/cards/:id', (req, res, next) => {
  try {
    const card = loadCard(req);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    audit(req, 'cartao.excluido', { entity: 'card', entityId: card.id, details: { title: card.title, boardId: card.board_id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
