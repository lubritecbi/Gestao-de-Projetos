'use strict';
// Backup consistente do banco (online, sem parar o sistema). Uso: npm run backup
// Agende diariamente (cron / Agendador de Tarefas) e guarde as cópias fora do servidor.
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const config = require('../src/config');

const dir = process.env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(dir, `gestao-${stamp}.db`);
db.backup(dest).then(() => {
  try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
  const keep = Number(process.env.BACKUP_KEEP || 30);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('gestao-') && f.endsWith('.db')).sort();
  files.slice(0, Math.max(0, files.length - keep)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  console.log(`Backup salvo em ${dest}`);
}).catch((e) => { console.error('Falha no backup:', e.message); process.exit(1); });
