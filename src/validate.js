'use strict';
const { z } = require('zod');
const { HttpError } = require('./access');

// Remove caracteres de controle (exceto quebra de linha/tab) e espaços nas pontas.
const clean = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

const text = (max, min = 0) => z.string().max(max * 4).transform(clean).pipe(z.string().min(min).max(max));
const date = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).')
  .refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Data inválida.'), z.null()]);
const id = z.coerce.number().int().positive().max(2 ** 31);
const priority = z.enum(['Alta', 'Média', 'Baixa']);

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first && first.path.length ? `${first.path.join('.')}: ` : '';
    throw new HttpError(400, `Dados inválidos. ${field}${first ? first.message : ''}`.trim());
  }
  return r.data;
}

module.exports = { z, text, date, id, priority, parse };
