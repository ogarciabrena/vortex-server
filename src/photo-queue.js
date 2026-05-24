/**
 * src/photo-queue.js
 * RF-01: Cola fotográfica desincronizada para evitar saturar el router 2.4GHz
 *
 * Problema: 50 alumnos con setTimeout(fn, 9000) exacto dispararían
 * simultáneamente, generando una ráfaga de 50 frames en el mismo milisegundo.
 *
 * Solución: Cada alumno recibe un intervalo base + jitter aleatorio ±1s,
 * distribuyendo los envíos en una ventana de 2 segundos.
 * Throughput real: ~1 foto cada 40ms en lugar de 50 simultáneas.
 */

'use strict';

const BASE_MS  = 9000;  // intervalo base
const JITTER_MS = 1000; // ±1 segundo de variación aleatoria

class PhotoQueue {
  constructor(baseInterval = BASE_MS) {
    this.base = baseInterval;
    this._timers = {}; // sessionId → NodeJS.Timeout
  }

  /**
   * Programa la próxima solicitud de foto para un alumno.
   * @param {string} sessionId
   * @param {Function} callback - fn que emite 'exam:request-photo' al socket del alumno
   */
  schedulePhoto(sessionId, callback) {
    this.cancel(sessionId);
    const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
    const delay  = Math.max(5000, this.base + jitter); // mínimo 5s
    this._timers[sessionId] = setTimeout(() => {
      delete this._timers[sessionId];
      callback();
    }, delay);
  }

  /** Cancela el timer de un alumno (al desconectarse o terminar examen) */
  cancel(sessionId) {
    if (this._timers[sessionId]) {
      clearTimeout(this._timers[sessionId]);
      delete this._timers[sessionId];
    }
  }

  /** Cancela todos los timers (stop global) */
  cancelAll() {
    Object.keys(this._timers).forEach(sid => this.cancel(sid));
  }
}

module.exports = PhotoQueue;
