'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { audit } = require('../audit');
const { hashPassword, verifyPassword, getDummyHash, checkPasswordPolicy } = require('../security/password');
const { createSession, destroySession, revokeUserSessions } = require('../security/session');
const { csrfProtection } = require('../security/csrf');
const { rateLimit } = require('../security/rateLimit');
const { requireAuth } = require('../access');
const { z, parse } = require('../validate');

const router = express.Router();
const GENERIC = 'E-mail ou senha incorretos.';

const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  fail: db.prepare('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?'),
  lock: db.prepare('UPDATE users SET locked_until = ?, failed_attempts = 0 WHERE id = ?'),
  ok: db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'),
  setPwd: db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?'),
};

// 10 tentativas por IP a cada 15 min + 20 por e-mail por hora (além do bloqueio de conta).
const loginByIp = rateLimit({ windowMs: 15 * 60000, max: 10, message: 'Muitas tentativas de acesso. Aguarde 15 minutos.' });
const loginByEmail = rateLimit({
  windowMs: 60 * 60000, max: 20,
  keyFn: (req) => 'e:' + String((req.body && req.body.email) || '').toLowerCase().slice(0, 200),
  message: 'Muitas tentativas para este usuário. Aguarde e tente novamente.',
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200).email(),
  password: z.string().min(1).max(128),
});

router.post('/login', csrfProtection({ requireToken: false }), loginByIp, loginByEmail, async (req, res, next) => {
  try {
    const r = loginSchema.safeParse(req.body);
    if (!r.success) {
      await verifyPassword('x', await getDummyHash());
      return res.status(401).json({ error: GENERIC });
    }
    const { email, password } = r.data;
    const user = q.byEmail.get(email);
    const now = Date.now();

    if (!user) {
      await verifyPassword(password, await getDummyHash()); // tempo constante
      audit(req, 'login.falha', { details: { email, motivo: 'usuario_inexistente' } });
      return res.status(401).json({ error: GENERIC });
    }
    if (user.locked_until && user.locked_until > now) {
      await verifyPassword(password, await getDummyHash());
      audit(req, 'login.bloqueado', { user, entity: 'user', entityId: user.id });
      // Mensagem genérica: não confirma que a conta existe.
      return res.status(401).json({ error: `${GENERIC} Após várias tentativas o acesso fica suspenso por ${config.lockoutMinutes} minutos.` });
    }
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid || !user.active) {
      if (valid && !user.active) {
        audit(req, 'login.falha', { user, entity: 'user', entityId: user.id, details: { motivo: 'inativo' } });
      } else {
        q.fail.run(user.id);
        const attempts = user.failed_attempts + 1;
        if (attempts >= config.maxFailedLogins) {
          q.lock.run(now + config.lockoutMinutes * 60000, user.id);
          audit(req, 'conta.bloqueada', { user, entity: 'user', entityId: user.id, details: { tentativas: attempts } });
        } else {
          audit(req, 'login.falha', { user, entity: 'user', entityId: user.id, details: { tentativas: attempts } });
        }
      }
      return res.status(401).json({ error: GENERIC });
    }

    q.ok.run(now, user.id);
    const { csrfToken } = createSession(req, res, user.id);
    audit(req, 'login.sucesso', { user, entity: 'user', entityId: user.id });
    return res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: !!user.must_change_password },
      csrfToken,
    });
  } catch (e) { return next(e); }
});

router.post('/logout', csrfProtection(), (req, res) => {
  if (req.user) audit(req, 'logout', { entity: 'user', entityId: req.user.id });
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, csrfToken: req.session.csrfToken });
});

router.get('/policy', (req, res) => {
  res.json({ minLength: config.passwordMinLength });
});

const changeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

router.post('/change-password', requireAuth, csrfProtection(),
  rateLimit({ windowMs: 15 * 60000, max: 10, keyFn: (req) => 'cp:' + (req.user ? req.user.id : req.ip) }),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = parse(changeSchema, req.body);
      const user = q.byId.get(req.user.id);
      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        audit(req, 'senha.troca_falha', { entity: 'user', entityId: user.id });
        return res.status(400).json({ error: 'A senha atual está incorreta.' });
      }
      if (currentPassword === newPassword) return res.status(400).json({ error: 'A nova senha precisa ser diferente da atual.' });
      const problems = checkPasswordPolicy(newPassword, { email: user.email, name: user.name });
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
      q.setPwd.run(await hashPassword(newPassword), Date.now(), user.id);
      revokeUserSessions(user.id, req); // encerra as outras sessões abertas
      audit(req, 'senha.alterada', { entity: 'user', entityId: user.id });
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

module.exports = router;
