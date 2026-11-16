'use strict';
const express = require('express');
const db = require('../db');
const { requireRole } = require('../access');
const { farol, today, DAY } = require('../metrics');

const router = express.Router();

router.get('/', (req, res) => {
  const t = today();
  const isAdmin = req.user.role === 'admin';
  const scope = isAdmin ? '' : 'JOIN board_members m ON m.board_id = b.id AND m.user_id = @uid';
  const boards = db.prepare(`
    SELECT b.id, b.code, b.name, b.priority, b.start_date AS startDate, b.due_date AS dueDate, u.name AS ownerName,
      (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id) AS total,
      (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.board_id = b.id AND l.is_done = 1) AS done,
      (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.board_id = b.id AND l.is_done = 0
         AND c.due_date IS NOT NULL AND c.due_date < @t) AS overdue
    FROM boards b ${scope} LEFT JOIN users u ON u.id = b.owner_id
    WHERE b.archived = 0 ORDER BY b.code`).all({ uid: req.user.id, t })
    .map((b) => ({ ...b, ...farol(b) }));

  const boardIds = boards.map((b) => b.id);
  let people = [];
  let throughput = [];
  if (boardIds.length) {
    const ph = boardIds.map(() => '?').join(',');
    const since30 = Date.now() - 30 * DAY;
    people = db.prepare(`
      SELECT u.id, u.name,
        SUM(CASE WHEN l.is_done = 0 THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN l.is_done = 0 AND c.due_date IS NOT NULL AND c.due_date < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN l.is_done = 1 AND c.completed_at >= ? THEN 1 ELSE 0 END) AS done30,
        SUM(CASE WHEN l.is_done = 1 AND c.completed_at >= ? AND (c.due_date IS NULL OR date(c.completed_at / 1000, 'unixepoch', 'localtime') <= c.due_date)
          THEN 1 ELSE 0 END) AS onTime30
      FROM cards c JOIN lists l ON l.id = c.list_id JOIN users u ON u.id = c.assignee_id
      WHERE c.board_id IN (${ph}) GROUP BY u.id ORDER BY u.name`).all(t, since30, since30, ...boardIds);
    // Entregas por semana nas últimas 8 semanas
    const since56 = Date.now() - 56 * DAY;
    const done = db.prepare(`SELECT completed_at FROM cards c JOIN lists l ON l.id = c.list_id
      WHERE l.is_done = 1 AND c.completed_at >= ? AND c.board_id IN (${ph})`).all(since56, ...boardIds);
    throughput = Array.from({ length: 8 }, (_, i) => {
      const end = Date.now() - (7 - i) * 7 * DAY;
      const start = end - 7 * DAY;
      return { weekEnding: new Date(end).toLocaleDateString('sv-SE'), count: done.filter((d) => d.completed_at > start && d.completed_at <= end).length };
    });
  }
  const totals = boards.reduce((a, b) => ({ total: a.total + b.total, done: a.done + b.done, overdue: a.overdue + b.overdue }),
    { total: 0, done: 0, overdue: 0 });
  res.json({ today: t, boards, people, throughput, totals });
});

router.get('/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
  res.json(db.prepare('SELECT id, at, user_email AS userEmail, action, entity, entity_id AS entityId, ip, details FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
});

module.exports = router;
