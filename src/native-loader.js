/**
 * src/native-loader.js
 * Carga better_sqlite3.node desde el directorio del ejecutable y shimea
 * el módulo `bindings` para que better-sqlite3 lo reciba sin pasar por el
 * sistema de resolución de rutas del snapshot (que no puede dlopen desde ahí).
 *
 * DISTRIBUCIÓN PORTÁTIL (USB / carpeta):
 *   vortex-linux           ← binario
 *   better_sqlite3.node    ← addon nativo (MISMO directorio que el binario)
 *   database/              ← creado automáticamente
 *
 * En modo desarrollo (node server.js) es un no-op completo.
 * DEBE ser el PRIMER require en server.js.
 */
'use strict';

if (typeof process.pkg === 'undefined') {
  module.exports = {};
  return; // no-op en modo desarrollo
}

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ADDON_NAME = 'better_sqlite3.node';
const execDir    = path.dirname(process.execPath);
const addonPath  = path.join(execDir, ADDON_NAME);

if (!fs.existsSync(addonPath)) {
  process.stderr.write(
    `\n[PKG] FATAL: Falta ${ADDON_NAME} en: ${execDir}\n` +
    `[PKG]        Copia better_sqlite3.node junto al ejecutable.\n\n`
  );
  process.exit(1);
}

// Pre-cargar el addon nativo desde el FS real
const nativeMod    = new Module(addonPath, null);
nativeMod.filename = addonPath;
nativeMod.loaded   = false;
try {
  process.dlopen(nativeMod, addonPath);
} catch (e) {
  process.stderr.write(`[PKG] FATAL: No se pudo cargar ${addonPath}: ${e.message}\n`);
  process.exit(1);
}
nativeMod.loaded = true;
process.stdout.write(`[PKG] Addon nativo listo: ${addonPath}\n`);

// Shimear `bindings` para que better-sqlite3 obtenga directamente
// nuestro addon pre-cargado, evitando el sistema de resolución del snapshot
// que no puede cargar archivos .node desde paths virtuales.
//
// Estrategia: interceptamos Module._load. Cuando la solicitud es 'bindings'
// devolvemos una función shim que ignora el nombre del addon y retorna
// nativeMod.exports (que ya tiene todos los bindings C++).
const bootstrapLoad = Module._load.bind(Module);

Module._load = function vortexLoad(request, parent, isMain) {
  // Interceptar el require('bindings') de better-sqlite3
  if (request === 'bindings') {
    return function bindingsShim(/* addonName */) {
      return nativeMod.exports;
    };
  }
  return bootstrapLoad(request, parent, isMain);
};

module.exports = { addonPath };
