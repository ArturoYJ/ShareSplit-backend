const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/http');

/**
 * Middleware de autenticación JWT.
 * Lee el token desde (en orden de prioridad):
 *   1. Cookie httpOnly: ss_token  (flujo con cookies)
 *   2. Header: Authorization: Bearer <token>  (flujo legacy / APIs externas)
 * Si es válido, adjunta req.user = { id, email, name }
 */
function authenticate(req, res, next) {
  // 1️⃣  Cookie httpOnly
  const cookieToken = req.cookies?.ss_token;
  // 2️⃣  Bearer header
  const authHeader = req.headers['authorization'];
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  const token = cookieToken || bearerToken;

  if (!token) {
    return sendError(res, 401, 'Token de autorización requerido', 'AUTH_TOKEN_REQUIRED');
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, name, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 401, 'Sesión expirada, inicia sesión nuevamente', 'AUTH_TOKEN_EXPIRED');
    }
    return sendError(res, 401, 'Token inválido', 'AUTH_TOKEN_INVALID');
  }
}

module.exports = { authenticate };
