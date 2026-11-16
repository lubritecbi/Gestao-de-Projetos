'use strict';
// Carrega os 3 projetos iniciais (mesmas atividades da planilha). Uso: npm run seed
const db = require('../src/db');

const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
if (!admin) { console.error('Crie um administrador antes: npm run create-admin -- email "Nome"'); process.exit(1); }

const projects = [
  { code: 'PRJ-001', name: 'Roteirizador', priority: 'Alta',
    description: 'Ferramenta para gerar e otimizar rotas de entrega, reduzindo km rodado e tempo de planejamento.',
    cards: [['1. Iniciação', 'Aprovar escopo inicial'], ['2. Planejamento', 'Levantar regras de roteirização (janelas, capacidade, frota)'],
      ['3. Execução', 'Desenvolver / configurar o roteirizador'], ['4. Testes / Piloto', 'Piloto em uma região / centro de distribuição'],
      ['5. Implantação / Encerramento', 'Treinar equipe e implantar']] },
  { code: 'PRJ-002', name: 'Validação de IPE Logística', priority: 'Alta',
    description: 'Automatizar a coleta e validação do IPE da operação logística, com conferência de dados e relatório de divergências.',
    cards: [['1. Iniciação', 'Aprovar escopo inicial'], ['2. Planejamento', 'Definir regras e fontes de dados do IPE'],
      ['3. Execução', 'Construir rotina de validação e relatório de divergências'], ['4. Testes / Piloto', 'Validar resultados com a área de Logística'],
      ['5. Implantação / Encerramento', 'Implantar e documentar']] },
  { code: 'PRJ-003', name: 'Validador de Execução por foto', priority: 'Alta',
    description: 'Validar a execução de serviços/entregas por meio de foto enviada em campo (evidência com data, hora e local).',
    cards: [['1. Iniciação', 'Aprovar escopo inicial'], ['2. Planejamento', 'Definir critérios de aceite da foto (data, hora, GPS, qualidade)'],
      ['3. Execução', 'Desenvolver captura e validação das fotos'], ['4. Testes / Piloto', 'Piloto com equipe de campo'],
      ['5. Implantação / Encerramento', 'Treinar equipes e implantar']] },
];
const LISTS = [['A fazer', 0], ['Em andamento', 0], ['Em validação', 0], ['Concluído', 1]];

db.transaction(() => {
  const now = Date.now();
  for (const p of projects) {
    if (db.prepare('SELECT 1 FROM boards WHERE code = ?').get(p.code)) { console.log(`${p.code} já existe, ignorado.`); continue; }
    const bid = db.prepare(`INSERT INTO boards (code, name, description, owner_id, priority, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.code, p.name, p.description, admin.id, p.priority, admin.id, now, now).lastInsertRowid;
    db.prepare('INSERT INTO board_members (board_id, user_id) VALUES (?, ?)').run(bid, admin.id);
    let firstList;
    LISTS.forEach(([n, d], i) => {
      const lid = db.prepare('INSERT INTO lists (board_id, name, position, is_done) VALUES (?, ?, ?, ?)').run(bid, n, i, d).lastInsertRowid;
      if (i === 0) firstList = lid;
    });
    p.cards.forEach(([phase, title], i) => db.prepare(`INSERT INTO cards (board_id, list_id, title, phase, priority, position, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Média', ?, ?, ?, ?)`).run(bid, firstList, title, phase, i, admin.id, now, now));
    console.log(`${p.code} ${p.name} criado.`);
  }
})();
