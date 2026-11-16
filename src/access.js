'use strict';
// Autorização: papéis globais + participação no quadro.
// admin  -> tudo (inclui usuários e auditoria)
// gestor -> cria quadros; gerencia quadros dos quais participa
// membro -> cria e move cartões nos quadros dos quais participa
// leitor -> somente leitura nos quadros dos quais participa
const db = require('./db');

const ROLES = ['admin', 'gestor', 'membro', 'leitor'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  return next();
}

// Bloqueia o uso do sistema até a troca da senha temporária.
function requirePasswordOk(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return res.status(403).json({ error: 'Troque sua senha para continuar.', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    return next();
  };
}

const qBoard = db.prepare('SELECT * FROM boards WHERE id = ? AND archived = 0');
const qMember = db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?');

function boardAccess(user, boardId) {
  const board = qBoard.get(boardId);
  if (!board) throw new HttpError(404, 'Quadro não encontrado.');
  const isAdmin = user.role === 'admin';
  const isMember = !!qMember.get(boardId, user.id);
  // Responde 404 (e não 403) para não revelar a existência de quadros alheios.
  if (!isAdmin && !isMember) throw new HttpError(404, 'Quadro não encontrado.');
  return {
    board,
    canEdit: isAdmin || (isMember && user.role !== 'leitor'),
    canManage: isAdmin || (isMember && user.role === 'gestor'),
  };
}

function assertEdit(access) {
  if (!access.canEdit) throw new HttpError(403, 'Seu perfil permite apenas visualizar este quadro.');
}
function assertManage(access) {
  if (!access.canManage) throw new HttpError(403, 'Apenas gestores do quadro ou administradores podem fazer isso.');
}

module.exports = { ROLES, HttpError, requireAuth, requirePasswordOk, requireRole, boardAccess, assertEdit, assertManage };
