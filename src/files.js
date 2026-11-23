'use strict';
// Regras dos anexos dos cartões: imagens (PNG, JPG, WEBP, GIF) e PDF, até 5 MB.

const MAX_ANEXO = 5 * 1024 * 1024;

// Descobre o tipo pelo conteúdo do arquivo (não pela extensão nem pelo que o navegador declara,
// que podem ser trocados). Assim um arquivo HTML ou script disfarçado de imagem é recusado.
function tipoReal(b) {
  const ini = (...x) => b.length >= x.length && x.every((v, i) => b[i] === v);
  if (ini(0x89, 0x50, 0x4E, 0x47)) return 'image/png';
  if (ini(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
  if (ini(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (ini(0x52, 0x49, 0x46, 0x46) && b.length >= 12 && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (ini(0x25, 0x50, 0x44, 0x46, 0x2D)) return 'application/pdf';
  return null;
}

// Nome exibido: sem caracteres de controle nem barras, até 150 caracteres.
const nomeArquivo = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 150) || 'arquivo';

// Cabeçalho Content-Disposition com nome acentuado seguro (RFC 6266).
function disposicao(tipo, nome) {
  const ascii = nome.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}

module.exports = { MAX_ANEXO, tipoReal, nomeArquivo, disposicao };
