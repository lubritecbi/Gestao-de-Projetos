'use strict';
// Uso: npm run create-admin -- email@empresa.com.br "Nome Completo"
// Cria o primeiro administrador com senha temporária (troca obrigatória no 1º acesso).
const db = require('../src/db');
const { hashPassword, generateTempPassword } = require('../src/security/password');

(async () => {
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(' ').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length < 2) {
    console.error('Uso: npm run create-admin -- email@empresa.com.br "Nome Completo"');
    process.exit(1);
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) {
    console.error('Já existe um usuário com este e-mail.');
    process.exit(1);
  }
  const temp = generateTempPassword();
  const now = Date.now();
  db.prepare(`INSERT INTO users (email, name, role, password_hash, must_change_password, password_changed_at, created_at)
    VALUES (?, ?, 'admin', ?, 1, ?, ?)`).run(email.toLowerCase(), name, await hashPassword(temp), now, now);
  db.prepare(`INSERT INTO audit_log (at, action, entity, details) VALUES (?, 'usuario.criado', 'user', ?)`)
    .run(now, JSON.stringify({ email: email.toLowerCase(), role: 'admin', origem: 'cli' }));
  console.log('\nAdministrador criado.');
  console.log(`E-mail: ${email.toLowerCase()}`);
  console.log(`Senha temporária: ${temp}`);
  console.log('Ela aparece só agora. A troca será exigida no primeiro acesso.\n');
})();
