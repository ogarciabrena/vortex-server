/**
 * src/admin-auth.js
 * RF-05: Autenticación Bearer Token para el dashboard admin.
 * Los tokens son temporales (24h) y se almacenan en memoria.
 * La contraseña maestra se configura vía variable de entorno ADMIN_PASS.
 */

'use strict';

const crypto = require('crypto');

class AdminAuth {
  constructor(password) {
    this.password = password;
    this._tokens = new Map(); // token → { createdAt }
    this._TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
  }

  generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    this._tokens.set(token, { createdAt: Date.now() });
    this._purgeExpired();
    return token;
  }

  verifyToken(token) {
    if (!token) return false;
    const entry = this._tokens.get(token);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > this._TOKEN_TTL_MS) {
      this._tokens.delete(token);
      return false;
    }
    return true;
  }

  _purgeExpired() {
    const now = Date.now();
    for (const [t, entry] of this._tokens) {
      if (now - entry.createdAt > this._TOKEN_TTL_MS) this._tokens.delete(t);
    }
  }

  /**
   * Actualiza la contraseña e invalida todos los tokens existentes.
   */
  updatePassword(newPassword) {
    this.password = newPassword;
    this._tokens.clear();
  }

  /**
   * Middleware Express para proteger rutas de admin.
   * Acepta:
   *   - Header: Authorization: Bearer <token>
   *   - Query: ?token=<token>
   *   - Cookie: vortex_token=<token>
   */
  middleware() {
    return (req, res, next) => {
      // Permitir acceso a la página de login sin token
      if (req.path === '/login' || req.path === '/login/' ||
          req.path === '/login.html' || req.path === '/login.html/') return next();

      let token = null;

      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      } else if (req.query.token) {
        token = req.query.token;
      } else if (req.headers.cookie) {
        const match = req.headers.cookie.match(/vortex_token=([^;]+)/);
        if (match) token = match[1];
      }

      if (this.verifyToken(token)) return next();

      // Para rutas HTML → redirigir al login
      const accept = req.headers.accept || '';
      if (accept.includes('text/html')) {
        return res.redirect(`/admin/login.html?redirect=${encodeURIComponent(req.originalUrl)}`);
      }

      res.status(401).json({ error: 'No autorizado. Se requiere token de admin.' });
    };
  }
}

module.exports = AdminAuth;
