'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../audit');
const { hashPassword, generateTempPassword } = require('../security/password');
const { revokeUserSessions } = require('../security/session');
const { requireRole, HttpError, ROLES } = require('../access');
const { z, text, id, parse } = require('../validate');

const router = express.Router();
const PUBLIC = 'id, email, name, role, active, must_change_password AS mustChangePassword, locked_until AS lockedUntil, last_login_at AS lastLoginAt, created_at AS createdAt';

// Lista reduzida para escolher responsáveis e membros (qualquer usuário logado).
router.get('/directory', (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name').all());
});

router.use(requireRole('admin'));

router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT ${PUBLIC} FROM users ORDER BY name`).all());
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().max(200).email(),
  name: text(120, 2),
  role: z.enum(ROLES),
});

router.post('/', async (req, res, next) => {
  try {
    const data = parse(createSchema, req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) {
      throw new HttpError(409, 'Já existe um usuário com este e-mail.');
    }
    const temp = generateTempPassword();
    const now = Date.now();
    const info = db.prepare(`INSERT INTO users (email, name, role, password_hash, must_change_password, password_changed_at, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).run(data.email, data.name, data.role, await hashPassword(temp), now, now);
    audit(req, 'usuario.criado', { entity: 'user', entityId: info.lastInsertRowid, details: { email: data.email, role: data.role } });
    // A senha temporária é exibida UMA vez ao administrador e nunca é armazenada em texto.
    res.status(201).json({ id: info.lastInsertRowid, temporaryPassword: temp });
  } catch (e) { next(e); }
});

const updateSchema = z.object({
  name: text(120, 2).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
}).strict();

router.patch('/:id', (req, res, next) => {
  try {
    const userId = parse(id, req.params.id);
    const data = parse(updateSchema, req.body);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'Usuário não encontrado.');
    if (userId === req.user.id && (data.active === false || (data.role && data.role !== 'admin'))) {
      throw new HttpError(400, 'Você não pode desativar ou rebaixar a própria conta.');
    }
    const removingAdmin = target.role === 'admin' && ((data.role && data.role !== 'admin') || data.active === false);
    if (removingAdmin) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) throw new HttpError(400, 'O sistema precisa de pelo menos um administrador ativo.');
    }
    db.prepare(`UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?`)
      .run(data.name ?? null, data.role ?? null, data.active === undefined ? null : Number(data.active), userId);
    if (data.active === false || (data.role && data.role !== target.role)) revokeUserSessions(userId);
    audit(req, 'usuario.alterado', { entity: 'user', entityId: userId, details: data });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const userId = parse(id, req.params.id);
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'Usuário não encontrado.');
    const temp = generateTempPassword();
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL,
      password_changed_at = ? WHERE id = ?`).run(await hashPassword(temp), Date.now(), userId);
    revokeUserSessions(userId);
    audit(req, 'senha.redefinida', { entity: 'user', entityId: userId });
    res.json({ temporaryPassword: temp });
  } catch (e) { next(e); }
});

router.post('/:id/unlock', (req, res, next) => {
  try {
    const userId = parse(id, req.params.id);
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
    audit(req, 'conta.desbloqueada', { entity: 'user', entityId: userId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
