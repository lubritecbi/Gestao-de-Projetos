'use strict';
// Mesmas regras de farol da planilha de acompanhamento.
const DAY = 86400000;

function today() { return new Date().toLocaleDateString('sv-SE'); } // AAAA-MM-DD no fuso do servidor
const toMs = (d) => Date.parse(d + 'T00:00:00');

function farol({ total, done, startDate, dueDate }) {
  const pct = total ? done / total : 0;
  if (total > 0 && done === total) return { farol: 'Concluído', pct };
  if (!startDate || !dueDate) return { farol: 'Sem data', pct };
  const now = toMs(today());
  const start = toMs(startDate);
  const due = toMs(dueDate);
  if (now > due && pct < 1) return { farol: 'Atrasado', pct };
  const elapsed = Math.max(0, (now - start) / Math.max(DAY, due - start));
  if (elapsed - pct > 0.2) return { farol: 'Atenção', pct };
  return { farol: 'No prazo', pct };
}

module.exports = { farol, today, DAY };
