/**
 * src/state-saver.js
 * RF-02: Persistencia transaccional inmediata de respuestas (< 100ms)
 * Usa better-sqlite3 síncrono — no hay await, no hay callback lag.
 */
'use strict';
class StateSaver {
  constructor(db) { this.db = db; }
  saveAnswer(sessionId, questionIdx, optionIdx) {
    // better-sqlite3 es completamente síncrono → escritura < 5ms típico
    this.db.saveAnswer(sessionId, questionIdx, optionIdx);
  }
}
module.exports = StateSaver;
