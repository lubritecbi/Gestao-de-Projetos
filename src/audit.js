'use strict';
const db = require('./db');
const config = require('./config');

const insert = db.prepare(`INSERT INTO audit_log (at, user_id, user_email, action, entity, entity_id, ip, details)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

// Nunca registre senhas, tokens ou conteúdo sensível em "details".
function audit(req, action, { entity = null, entityId = null, details = null, user = null } = {}) {
  const u = user || (req && req.user) || null;
  insert.run(
    Date.now(),
    u ? u.id : null,
    u ? u.email : null,
    action,
    entity,
    entityId,
    req ? req.ip : null,
    details ? JSON.stringify(details).slice(0, 2000) : null,
  );
}

function purgeOldAudit() {
  if (!config.auditRetentionDays) return;
  const cutoff = Date.now() - config.auditRetentionDays * 86400000;
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff);
}

module.exports = { audit, purgeOldAudit };
