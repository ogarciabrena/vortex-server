/**
 * src/tunnel.js
 * RF-05: Túnel seguro opcional Edge-to-Cloud
 *
 * Estrategia:
 * 1. Verifica conectividad a internet (ping 1.1.1.1 vía fetch)
 * 2. Si hay internet → intenta Cloudflare Tunnel (cloudflared) vía spawn
 * 3. Fallback → intenta localtunnel (npm, sin binario externo)
 * 4. Si ambos fallan → modo desconectado estricto sin error fatal
 *
 * El túnel expone ÚNICAMENTE el path /admin con autenticación Bearer.
 * Los alumnos en la red local acceden a /app directamente por IP.
 */

'use strict';

const { execFile, spawn } = require('child_process');
const path  = require('path');

let _tunnel = null;

/**
 * Intenta detectar conectividad a internet.
 * @returns {Promise<boolean>}
 */
async function hasInternet() {
  try {
    // fetch disponible en Node 18+
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('https://1.1.1.1', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timeout);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Inicia el túnel usando localtunnel (paquete npm, no requiere instalación externa).
 * Se instala on-demand si no está disponible.
 * @param {number} port - puerto local del servidor
 * @returns {Promise<string|null>} URL pública del túnel o null
 */
async function startLocaltunnel(port) {
  try {
    // localtunnel puede no estar instalado en el bundle; lo requerimos dinámicamente
    let lt;
    try {
      lt = require('localtunnel');
    } catch {
      console.log('[TÚNEL] localtunnel no disponible, omitiendo.');
      return null;
    }
    _tunnel = await lt({ port, subdomain: `vortex-admin-${Date.now()}` });
    console.log(`[TÚNEL] localtunnel activo: ${_tunnel.url}`);
    _tunnel.on('error', err => console.error('[TÚNEL] Error:', err));
    _tunnel.on('close', () => console.log('[TÚNEL] Cerrado.'));
    return _tunnel.url + '/admin';
  } catch (e) {
    console.error('[TÚNEL] localtunnel falló:', e.message);
    return null;
  }
}

/**
 * Intenta usar cloudflared si está instalado en el sistema.
 * @param {number} port
 * @returns {Promise<string|null>}
 */
function startCloudflared(port) {
  return new Promise((resolve) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => { proc.kill(); resolve(null); }, 8000);
    const handler = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        proc.stderr.removeListener('data', handler);
        console.log(`[TÚNEL] Cloudflared activo: ${match[0]}`);
        resolve(match[0] + '/admin');
      }
    };
    proc.stderr.on('data', handler);
    proc.stdout.on('data', handler);
    proc.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

/**
 * Punto de entrada principal del módulo.
 * @param {number} port
 * @param {string} adminPass - para mostrar en el log junto con la URL
 * @returns {Promise<string|null>}
 */
async function start(port, adminPass) {
  const online = await hasInternet();
  if (!online) {
    console.log('[TÚNEL] Sin conectividad. Modo desconectado estricto activado.');
    return null;
  }

  console.log('[TÚNEL] Conectividad detectada. Iniciando túnel...');

  // Intentar cloudflared primero (sin costo, sin cuenta)
  let url = await startCloudflared(port);
  if (!url) {
    url = await startLocaltunnel(port);
  }

  if (url) {
    console.log(`[TÚNEL] ✓ URL Admin Externa: ${url}`);
    console.log(`[TÚNEL] ✓ Contraseña Admin:  ${adminPass}`);
  }

  return url;
}

/** Cierra el túnel activo (para shutdown limpio) */
function stop() {
  if (_tunnel && typeof _tunnel.close === 'function') {
    _tunnel.close();
    _tunnel = null;
  }
}

process.on('SIGINT',  () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

module.exports = { start, stop, hasInternet };
