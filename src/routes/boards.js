'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../audit');
const { boardAccess, assertEdit, assertManage, requireRole, HttpError } = require('../access');
const { z, text, date, id, priority, parse } = require('../validate');
const { farol, today } = require('../metrics');

const router = express.Router();
const DEFAULT_LISTS = [['A fazer', 0], ['Em andamento', 0], ['Em validação', 0], ['Concluído', 1]];

const statsStmt = db.prepare(`
  SELECT COUNT(c.id) AS total,
         COALESCE(SUM(l.is_done), 0) AS done,
         COALESCE(SUM(CASE WHEN l.is_done = 0 AND c.due_date IS NOT NULL AND c.due_date < ? THEN 1 ELSE 0 END), 0) AS overdue
  FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.board_id = ?`);

function boardSummary(b) {
  const s = statsStmt.get(today(), b.id);
  const f = farol({ total: s.total, done: s.done, startDate: b.start_date, dueDate: b.due_date });
  return { ...b, total: s.total, done: s.done, overdue: s.overdue, pct: f.pct, farol: f.farol };
}

router.get('/', (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`SELECT b.*, u.name AS owner_name FROM boards b LEFT JOIN users u ON u.id = b.owner_id
        WHERE b.archived = 0 ORDER BY b.code`).all()
    : db.prepare(`SELECT b.*, u.name AS owner_name FROM boards b LEFT JOIN users u ON u.id = b.owner_id
        JOIN board_members m ON m.board_id = b.id AND m.user_id = ? WHERE b.archived = 0 ORDER BY b.code`).all(req.user.id);
  res.json(rows.map(boardSummary));
});

// Projetos arquivados: só o administrador vê (somente leitura).
router.get('/archived', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Você não tem permissão para esta ação.');
    const rows = db.prepare(`SELECT b.id, b.code, b.name, b.area, b.updated_at AS archivedAt, u.name AS ownerName,
        (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id) AS total,
        (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.board_id = b.id AND l.is_done = 1) AS done
      FROM boards b LEFT JOIN users u ON u.id = b.owner_id WHERE b.archived = 1 ORDER BY b.code`).all();
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/:id/unarchive', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Apenas administradores podem desarquivar projetos.');
    const boardId = parse(id, req.params.id);
    const r = db.prepare('UPDATE boards SET archived = 0, updated_at = ? WHERE id = ? AND archived = 1').run(Date.now(), boardId);
    if (!r.changes) throw new HttpError(404, 'Projeto arquivado não encontrado.');
    audit(req, 'quadro.desarquivado', { entity: 'board', entityId: boardId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const boardFields = {
  code: text(20, 2).refine((s) => /^[A-Za-z0-9._-]+$/.test(s), 'Use letras, números, ponto, hífen ou sublinhado.'),
  name: text(120, 2),
  description: text(4000),
  area: text(120),
  sponsor: text(120),
  ownerId: z.union([id, z.null()]),
  priority,
  startDate: date,
  dueDate: date,
};
const createSchema = z.object({ ...boardFields, code: boardFields.code.optional() }).partial({
  description: true, area: true, sponsor: true, ownerId: true, priority: true, startDate: true, dueDate: true,
});
const updateSchema = z.object(boardFields).partial().strict();

function checkDates(start, due) {
  if (start && due && due < start) throw new HttpError(400, 'O fim previsto não pode ser antes do início.');
}
function checkUser(userId) {
  if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) {
    throw new HttpError(400, 'Responsável não encontrado ou inativo.');
  }
}
function nextCode() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM boards').get().n + 1;
  for (let i = n; ; i++) {
    const code = `PRJ-${String(i).padStart(3, '0')}`;
    if (!db.prepare('SELECT 1 FROM boards WHERE code = ?').get(code)) return code;
  }
}

router.post('/', requireRole('admin', 'gestor'), (req, res, next) => {
  try {
    const d = parse(createSchema, req.body);
    checkDates(d.startDate, d.dueDate);
    checkUser(d.ownerId);
    const code = d.code || nextCode();
    if (db.prepare('SELECT 1 FROM boards WHERE code = ?').get(code)) throw new HttpError(409, 'Já existe um projeto com este ID.');
    const now = Date.now();
    const boardId = db.transaction(() => {
      const info = db.prepare(`INSERT INTO boards (code, name, description, area, sponsor, owner_id, priority, start_date, due_date, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, d.name, d.description || '', d.area || '', d.sponsor || '',
        d.ownerId ?? req.user.id, d.priority || 'Média', d.startDate ?? null, d.dueDate ?? null, req.user.id, now, now);
      const bid = info.lastInsertRowid;
      const addList = db.prepare('INSERT INTO lists (board_id, name, position, is_done) VALUES (?, ?, ?, ?)');
      DEFAULT_LISTS.forEach(([name, done], i) => addList.run(bid, name, i, done));
      const addMember = db.prepare('INSERT OR IGNORE INTO board_members (board_id, user_id) VALUES (?, ?)');
      addMember.run(bid, req.user.id);
      if (d.ownerId) addMember.run(bid, d.ownerId);
      return bid;
    })();
    audit(req, 'quadro.criado', { entity: 'board', entityId: boardId, details: { code, name: d.name } });
    res.status(201).json({ id: boardId, code });
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    const access = boardAccess(req.user, boardId, { verArquivado: true });
    const lists = db.prepare('SELECT id, name, position, is_done AS isDone FROM lists WHERE board_id = ? ORDER BY position').all(boardId);
    const cards = db.prepare(`SELECT c.id, c.list_id AS listId, c.title, c.description, c.assignee_id AS assigneeId, u.name AS assigneeName,
        c.due_date AS dueDate, c.priority, c.phase, c.checklists, c.position, c.completed_at AS completedAt, c.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM attachments a WHERE a.card_id = c.id) AS attachmentCount
      FROM cards c LEFT JOIN users u ON u.id = c.assignee_id WHERE c.board_id = ? ORDER BY c.position`).all(boardId)
      .map((c) => ({ ...c, checklists: JSON.parse(c.checklists) }));
    const members = db.prepare(`SELECT u.id, u.name, u.email, u.role FROM board_members m JOIN users u ON u.id = m.user_id
      WHERE m.board_id = ? AND u.active = 1 ORDER BY u.name`).all(boardId);
    const owner = access.board.owner_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(access.board.owner_id) : null;
    res.json({
      board: { ...boardSummary(access.board), owner_name: owner ? owner.name : null, archived: !!access.archived },
      permissions: { canEdit: access.canEdit, canManage: access.canManage },
      lists, cards, members,
    });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    const access = boardAccess(req.user, boardId);
    assertManage(access);
    const d = parse(updateSchema, req.body);
    const b = access.board;
    checkDates(d.startDate !== undefined ? d.startDate : b.start_date, d.dueDate !== undefined ? d.dueDate : b.due_date);
    if (d.ownerId !== undefined) checkUser(d.ownerId);
    if (d.code && d.code !== b.code && db.prepare('SELECT 1 FROM boards WHERE code = ?').get(d.code)) {
      throw new HttpError(409, 'Já existe um projeto com este ID.');
    }
    const map = { code: 'code', name: 'name', description: 'description', area: 'area', sponsor: 'sponsor',
      ownerId: 'owner_id', priority: 'priority', startDate: 'start_date', dueDate: 'due_date' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col} = ?`); vals.push(d[k]); }
    if (sets.length) {
      db.prepare(`UPDATE boards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), boardId);
      audit(req, 'quadro.alterado', { entity: 'board', entityId: boardId, details: Object.keys(d) });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    assertManage(boardAccess(req.user, boardId));
    db.prepare('UPDATE boards SET archived = 1, updated_at = ? WHERE id = ?').run(Date.now(), boardId);
    audit(req, 'quadro.arquivado', { entity: 'board', entityId: boardId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/:id/members', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    assertManage(boardAccess(req.user, boardId));
    const { userIds } = parse(z.object({ userIds: z.array(id).max(500) }), req.body);
    const ids = [...new Set(userIds)];
    if (req.user.role !== 'admin' && !ids.includes(req.user.id)) ids.push(req.user.id); // gestor não se remove
    const valid = ids.filter((u) => db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(u));
    db.transaction(() => {
      db.prepare('DELETE FROM board_members WHERE board_id = ?').run(boardId);
      const ins = db.prepare('INSERT INTO board_members (board_id, user_id) VALUES (?, ?)');
      valid.forEach((u) => ins.run(boardId, u));
    })();
    audit(req, 'quadro.membros', { entity: 'board', entityId: boardId, details: { userIds: valid } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Listas (colunas) ----------
router.post('/:id/lists', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    assertEdit(boardAccess(req.user, boardId));
    const d = parse(z.object({ name: text(80, 1), isDone: z.boolean().optional() }), req.body);
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lists WHERE board_id = ?').get(boardId).p;
    const info = db.prepare('INSERT INTO lists (board_id, name, position, is_done) VALUES (?, ?, ?, ?)')
      .run(boardId, d.name, pos, d.isDone ? 1 : 0);
    audit(req, 'lista.criada', { entity: 'list', entityId: info.lastInsertRowid, details: { boardId, name: d.name } });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});

// ---------- Cartões ----------
const cardFields = {
  title: text(200, 1),
  description: text(10000),
  assigneeId: z.union([id, z.null()]),
  dueDate: date,
  priority,
  phase: text(60),
  // Até 10 checklists por cartão e 30 itens cada; itens sem texto são descartados.
  checklists: z.array(z.object({
    title: text(80),
    items: z.array(z.object({ text: text(200), done: z.boolean() }).strict()).max(30),
  }).strict()).max(10)
    .transform((cls) => cls.map((cl) => ({ title: cl.title || 'Checklist', items: cl.items.filter((i) => i.text) }))),
};

router.post('/:id/cards', (req, res, next) => {
  try {
    const boardId = parse(id, req.params.id);
    assertEdit(boardAccess(req.user, boardId));
    const d = parse(z.object({ listId: id, ...cardFields }).partial({
      description: true, assigneeId: true, dueDate: true, priority: true, phase: true, checklists: true }), req.body);
    const list = db.prepare('SELECT * FROM lists WHERE id = ? AND board_id = ?').get(d.listId, boardId);
    if (!list) throw new HttpError(400, 'Coluna inválida para este quadro.');
    if (d.assigneeId && !db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, d.assigneeId)) {
      throw new HttpError(400, 'O responsável precisa ser membro do quadro.');
    }
    const now = Date.now();
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE list_id = ?').get(list.id).p;
    const info = db.prepare(`INSERT INTO cards (board_id, list_id, title, description, assignee_id, due_date, priority, phase, checklists, position,
        completed_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(boardId, list.id, d.title, d.description || '', d.assigneeId ?? null, d.dueDate ?? null, d.priority || 'Média',
        d.phase || '', JSON.stringify(d.checklists || []), pos, list.is_done ? now : null, req.user.id, now, now);
    audit(req, 'cartao.criado', { entity: 'card', entityId: info.lastInsertRowid, details: { boardId, title: d.title } });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { next(e); }
});

module.exports = { router, cardFields };
