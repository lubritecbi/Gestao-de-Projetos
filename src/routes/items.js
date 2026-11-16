'use strict';
// Rotas de listas e cartões endereçados pelo próprio ID (a autorização sempre verifica o quadro dono).
const express = require('express');
const db = require('../db');
const { audit } = require('../audit');
const { boardAccess, assertEdit, HttpError } = require('../access');
const { z, text, id, parse } = require('../validate');
const { cardFields } = require('./boards');

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

router.delete('/cards/:id', (req, res, next) => {
  try {
    const card = loadCard(req);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    audit(req, 'cartao.excluido', { entity: 'card', entityId: card.id, details: { title: card.title, boardId: card.board_id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
