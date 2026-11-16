'use strict';
// Hash de senha com scrypt (nativo do Node, sem dependência externa).
// Parâmetros: N=2^15, r=8, p=1 (~32 MiB por hash) — recomendação OWASP para scrypt.
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../config');

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Hash fictício: usado quando o e-mail não existe, para o tempo de resposta não revelar usuários válidos.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(24).toString('base64'));
  return dummyHash;
}

const COMMON = new Set([
  'senha123456', '123456789012', 'qwertyuiop12', 'password1234', 'admin1234567',
  'mudar@123456', 'empresa@2026', 'senha@123456', '1234567890ab', 'abcdef123456',
]);

// Retorna lista de problemas (vazia = senha aceita).
function checkPasswordPolicy(password, { email = '', name = '' } = {}) {
  const errors = [];
  const pw = String(password || '');
  if (pw.length < config.passwordMinLength) errors.push(`Use pelo menos ${config.passwordMinLength} caracteres.`);
  if (pw.length > 128) errors.push('Use no máximo 128 caracteres.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) errors.push('Combine pelo menos 3 tipos: minúsculas, maiúsculas, números e símbolos.');
  if (/(.)\1{3,}/.test(pw)) errors.push('Evite repetir o mesmo caractere 4 vezes seguidas.');
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) errors.push('Essa senha é comum demais.');
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) errors.push('A senha não pode conter seu usuário de e-mail.');
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) { errors.push('A senha não pode conter seu nome.'); break; }
  }
  return errors;
}

// Senha temporária forte (entregue uma única vez ao administrador).
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%*?-_+';
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = { hashPassword, verifyPassword, getDummyHash, checkPasswordPolicy, generateTempPassword };
