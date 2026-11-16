'use strict';
// Sessões no servidor. O cookie guarda só um token aleatório de 256 bits;
// o banco guarda apenas o SHA-256 dele (um vazamento do banco não permite sequestrar sessões).
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
const IDLE_MS = config.sessionIdleMinutes * 60 * 1000;
const ABS_MS = config.sessionAbsoluteHours * 3600 * 1000;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const q = {
  insert: db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare(`SELECT s.*, u.email, u.name, u.role, u.active, u.must_change_password, u.password_changed_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
  touch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
  del: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  delUserExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
  purge: db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?'),
};

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: ABS_MS,
  };
}

function createSession(req, res, userId) {
  // Rotação: invalida qualquer sessão anterior trazida pelo navegador (evita fixação de sessão).
  const old = req.cookies && req.cookies[COOKIE];
  if (old) q.del.run(sha256(old));
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q.insert.run(sha256(token), userId, csrf, now, now, now + ABS_MS, req.ip,
    String(req.get('user-agent') || '').slice(0, 300));
  res.cookie(COOKIE, token, cookieOptions());
  return { csrfToken: csrf };
}

function destroySession(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) q.del.run(sha256(token));
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
}

function revokeUserSessions(userId, exceptReq = null) {
  const token = exceptReq && exceptReq.cookies && exceptReq.cookies[COOKIE];
  if (token) q.delUserExcept.run(userId, sha256(token));
  else q.delUser.run(userId);
}

// Middleware: identifica o usuário a partir do cookie (não bloqueia; quem bloqueia é requireAuth).
function loadSession(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token || token.length > 100) return next();
  const hash = sha256(token);
  const s = q.get.get(hash);
  const now = Date.now();
  if (!s) return next();
  if (s.expires_at < now || s.last_seen_at + IDLE_MS < now || !s.active) {
    q.del.run(hash);
    res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
    return next();
  }
  if (now - s.last_seen_at > 60 * 1000) q.touch.run(now, hash);
  req.session = { tokenHash: hash, csrfToken: s.csrf_token };
  const pwdExpired = config.passwordMaxAgeDays > 0 &&
    s.password_changed_at + config.passwordMaxAgeDays * 86400000 < now;
  req.user = {
    id: s.user_id, email: s.email, name: s.name, role: s.role,
    mustChangePassword: !!s.must_change_password || pwdExpired,
  };
  return next();
}

function purgeExpiredSessions() {
  const now = Date.now();
  q.purge.run(now, now - IDLE_MS);
}

module.exports = { createSession, destroySession, revokeUserSessions, loadSession, purgeExpiredSessions, COOKIE };
