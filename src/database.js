/**
 * src/database.js
 * Capa de persistencia SQLite (better-sqlite3 — SÍNCRONO)
 * RF-02: todas las escrituras son transaccionales y síncronas → < 100ms
 */

'use strict';

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class Database {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(dbPath);
    // WAL mode: escrituras más rápidas, lecturas no bloqueadas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -8000'); // 8MB cache
    this._initSchema();
    console.log(`[DB] SQLite abierta: ${dbPath}`);
  }

  _initSchema() {
    this.db.exec(`
      -- Exámenes
      CREATE TABLE IF NOT EXISTS exams (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        questions   TEXT NOT NULL, -- JSON
        created_at  INTEGER DEFAULT (unixepoch())
      );

      -- Sesiones de alumnos
      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT PRIMARY KEY,
        socket_id       TEXT,
        student_name    TEXT NOT NULL,
        matricula       TEXT DEFAULT '',
        exam_id         TEXT,
        current_question INTEGER DEFAULT 0,
        phase           TEXT DEFAULT 'lobby',
        suspicion_score INTEGER DEFAULT 0,
        camera_ok       INTEGER DEFAULT -1, -- -1 pendiente, 0 fallo, 1 ok
        token_mode      INTEGER DEFAULT 0,
        last_heartbeat  INTEGER,
        created_at      INTEGER DEFAULT (unixepoch()),
        finished_at     INTEGER,
        final_score     REAL
      );

      -- Respuestas individuales (RF-02: escritura inmediata)
      CREATE TABLE IF NOT EXISTS answers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        question_idx INTEGER NOT NULL,
        option_idx  INTEGER NOT NULL,
        answered_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(session_id, question_idx)
      );

      -- Fotos de alumnos (thumbnails base64)
      CREATE TABLE IF NOT EXISTS photos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        image_data  TEXT NOT NULL,
        taken_at    INTEGER NOT NULL
      );

      -- Bitácora de sospecha
      CREATE TABLE IF NOT EXISTS suspicion_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        event       TEXT NOT NULL,
        detail      TEXT,
        logged_at   INTEGER DEFAULT (unixepoch())
      );

      -- Tokens manuales (RF-03)
      CREATE TABLE IF NOT EXISTS tokens (
        session_id  TEXT PRIMARY KEY,
        token       TEXT NOT NULL,
        used        INTEGER DEFAULT 0,
        created_at  INTEGER DEFAULT (unixepoch())
      );

      -- Configuración persistente (contraseña admin, flags)
      CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch())
      );

      -- Padrón de alumnos (cargado desde CSV por el profesor)
      CREATE TABLE IF NOT EXISTS students_roster (
        matricula  TEXT PRIMARY KEY,
        nombre     TEXT NOT NULL,
        added_at   INTEGER DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id);
      CREATE INDEX IF NOT EXISTS idx_suspicion_session ON suspicion_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_suspicion_event ON suspicion_log(event);
    `);

    // Insertar examen de demo si no existe ninguno
    const count = this.db.prepare('SELECT COUNT(*) as c FROM exams').get();
    if (count.c === 0) this._seedDemoExam();
  }

  _seedDemoExam() {
    const demo = {
      id: 'exam-demo-001',
      title: 'Evaluación de Demostración',
      questions: JSON.stringify([
        {
          text: '¿Cuál es el resultado de 12 × 8?',
          options: ['84', '96', '104', '88'],
          correct: 1
        },
        {
          text: '¿En qué año terminó la Segunda Guerra Mundial?',
          options: ['1943', '1944', '1945', '1946'],
          correct: 2
        },
        {
          text: '¿Cuál es la capital de Francia?',
          options: ['Berlín', 'Madrid', 'Roma', 'París'],
          correct: 3
        },
        {
          text: '¿Qué elemento tiene símbolo químico "O"?',
          options: ['Oro', 'Osmio', 'Oxígeno', 'Cobre'],
          correct: 2
        },
        {
          text: '¿Cuántos lados tiene un hexágono?',
          options: ['5', '6', '7', '8'],
          correct: 1
        }
      ])
    };
    this.db.prepare('INSERT INTO exams (id, title, questions) VALUES (?, ?, ?)')
      .run(demo.id, demo.title, demo.questions);
    console.log('[DB] Examen de demo insertado.');
  }

  // ── SESIONES ──────────────────────────────────────────────────────────────
  createSession(sessionId, data) {
    this.db.prepare(`
      INSERT INTO sessions
        (session_id, socket_id, student_name, matricula, exam_id, current_question,
         phase, suspicion_score, camera_ok, token_mode, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      data.socketId,
      data.studentName,
      data.matricula || '',
      data.examId || null,
      data.currentQ || 0,
      data.phase || 'lobby',
      0, -1, 0,
      Date.now()
    );
  }

  updateSessionSocket(sessionId, socketId) {
    this.db.prepare('UPDATE sessions SET socket_id = ? WHERE session_id = ?')
      .run(socketId, sessionId);
  }

  updateSessionField(sessionId, field, value) {
    const allowed = ['current_question','phase','suspicion_score','camera_ok',
                     'token_mode','last_heartbeat','socket_id','exam_id',
                     'finished_at','final_score','matricula'];
    if (!allowed.includes(field)) return;
    this.db.prepare(`UPDATE sessions SET ${field} = ? WHERE session_id = ?`)
      .run(value, sessionId);
  }

  getActiveSessions() {
    return this.db.prepare(`
      SELECT * FROM sessions WHERE phase NOT IN ('finished','cancelled')
    `).all();
  }

  // ── RESPUESTAS (RF-02: síncrono < 100ms) ─────────────────────────────────
  saveAnswer(sessionId, questionIdx, optionIdx) {
    this.db.prepare(`
      INSERT OR IGNORE INTO answers (session_id, question_idx, option_idx)
      VALUES (?, ?, ?)
    `).run(sessionId, questionIdx, optionIdx);
  }

  getAnswersBySession(sessionId) {
    const rows = this.db.prepare('SELECT question_idx, option_idx FROM answers WHERE session_id = ?')
      .all(sessionId);
    const map = {};
    rows.forEach(r => { map[r.question_idx] = r.option_idx; });
    return map;
  }

  // ── FOTOS ─────────────────────────────────────────────────────────────────
  savePhoto(sessionId, imageData, takenAt) {
    this.db.prepare('INSERT INTO photos (session_id, image_data, taken_at) VALUES (?, ?, ?)')
      .run(sessionId, imageData, takenAt);
  }

  getLatestPhoto(sessionId) {
    return this.db.prepare(`
      SELECT image_data, taken_at FROM photos
      WHERE session_id = ? ORDER BY taken_at DESC LIMIT 1
    `).get(sessionId);
  }

  // ── BITÁCORA SOSPECHA ─────────────────────────────────────────────────────
  logSuspicion(sessionId, event, detail) {
    this.db.prepare('INSERT INTO suspicion_log (session_id, event, detail) VALUES (?, ?, ?)')
      .run(sessionId, event, detail || '');
  }

  getSuspicionLog(sessionId = null) {
    if (sessionId) {
      return this.db.prepare(`
        SELECT sl.*, s.student_name FROM suspicion_log sl
        JOIN sessions s ON s.session_id = sl.session_id
        WHERE sl.session_id = ? ORDER BY sl.logged_at DESC
      `).all(sessionId);
    }
    return this.db.prepare(`
      SELECT sl.*, s.student_name FROM suspicion_log sl
      JOIN sessions s ON s.session_id = sl.session_id
      ORDER BY sl.logged_at DESC LIMIT 500
    `).all();
  }

  // ── TOKENS (RF-03) ────────────────────────────────────────────────────────
  saveToken(sessionId, token) {
    this.db.prepare(`
      INSERT OR REPLACE INTO tokens (session_id, token, used, created_at)
      VALUES (?, ?, 0, unixepoch())
    `).run(sessionId, token);
  }

  getToken(sessionId) {
    const row = this.db.prepare('SELECT token FROM tokens WHERE session_id = ? AND used = 0')
      .get(sessionId);
    return row ? row.token : null;
  }

  // ── RESULTADOS FINALES ────────────────────────────────────────────────────
  saveFinalScore(sessionId, score) {
    this.db.prepare(`
      UPDATE sessions SET final_score = ?, finished_at = unixepoch(), phase = 'finished'
      WHERE session_id = ?
    `).run(score, sessionId);
  }

  getFinalResults() {
    return this.db.prepare(`
      SELECT s.session_id, s.student_name, s.final_score,
             e.title as exam_title, s.suspicion_score,
             s.camera_ok, s.token_mode, s.finished_at
      FROM sessions s
      LEFT JOIN exams e ON e.id = s.exam_id
      WHERE s.phase = 'finished'
      ORDER BY s.finished_at DESC
    `).all();
  }

  // ── EXÁMENES ──────────────────────────────────────────────────────────────
  getAllExams() {
    return this.db.prepare('SELECT id, title FROM exams').all();
  }

  getExamRaw(examId) {
    return this.db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  }

  // ── CONFIGURACIÓN PERSISTENTE ─────────────────────────────────────────────
  getConfig(key) {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setConfig(key, value) {
    this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, unixepoch())
    `).run(key, String(value));
  }

  // ── PADRÓN DE ALUMNOS ─────────────────────────────────────────────────────
  importStudentRoster(students) {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO students_roster (matricula, nombre) VALUES (?, ?)'
    );
    const insertAll = this.db.transaction((list) => {
      for (const s of list) insert.run(s.matricula, s.nombre);
    });
    insertAll(students);
  }

  lookupStudentByMatricula(matricula) {
    return this.db.prepare(
      'SELECT nombre FROM students_roster WHERE matricula = ?'
    ).get(matricula);
  }

  clearStudentRoster() {
    this.db.prepare('DELETE FROM students_roster').run();
  }

  getRosterCount() {
    return this.db.prepare('SELECT COUNT(*) as c FROM students_roster').get().c;
  }

  getAllRoster() {
    return this.db.prepare('SELECT matricula, nombre FROM students_roster ORDER BY nombre').all();
  }
}

module.exports = Database;
