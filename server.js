/**
 * VORTEX SERVER v1.0
 * Sistema de Evaluación Escolar Edge — Red Local Desconectada
 * Arquitectura: Express + Socket.io + SQLite (better-sqlite3)
 *
 * [RF-01] Saturación 2.4GHz → Cola fotográfica desfasada (8-10s jitter)
 * [RF-02] Apagón servidor   → State Saver transaccional (<100ms)
 * [RF-03] Fallas de cliente → Graceful Degradation + Modo Token
 * [RF-04] Trampas alumno    → Lógica 100% backend + Heartbeat WS 2s
 * [RF-05] Acceso externo    → Túnel cifrado sólo en endpoint /admin
 */

'use strict';

// RF-PKG: debe ser el primero — extrae better-sqlite3.node del snapshot al FS real
require('./src/native-loader');

const express    = require('express');
const http       = require('http');
const socketio   = require('socket.io');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');
const helmet     = require('helmet');

const DB         = require('./src/database');
const StateSaver = require('./src/state-saver');
const PhotoQueue = require('./src/photo-queue');
const Tunnel     = require('./src/tunnel');
const ExamEngine = require('./src/exam-engine');
const AdminAuth  = require('./src/admin-auth');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const ADMIN_PASS_DEFAULT = process.env.ADMIN_PASS || 'vortex-admin-2025';
const HEARTBEAT_INTERVAL_MS = 2000;
const PHOTO_INTERVAL_MS     = 9000;
const MAX_STUDENTS          = 50;

// Detección de entorno PKG (binario portátil)
// En modo pkg, __dirname apunta al snapshot virtual (solo lectura).
// La BD y archivos mutables deben vivir junto al ejecutable.
const isPackaged = typeof process.pkg !== 'undefined';
const DATA_DIR   = isPackaged ? path.dirname(process.execPath) : __dirname;
const STATIC_DIR = __dirname; // OK para lectura de assets en snapshot

// ─── APP SETUP ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketio(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5   // RF-01: 100KB max por frame WS
});

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '150kb' }));  // 150kb para CSV + photos inline

// ─── INICIALIZACIÓN ──────────────────────────────────────────────────────────
const db         = new DB(path.join(DATA_DIR, 'database', 'vortex.db'));
const stateSaver = new StateSaver(db);
const photoQueue = new PhotoQueue(PHOTO_INTERVAL_MS);
const examEngine = new ExamEngine(db);

// Leer contraseña guardada; la variable de entorno tiene precedencia
const savedPass  = db.getConfig('admin_password');
const adminAuth  = new AdminAuth(savedPass || ADMIN_PASS_DEFAULT);

// ─── ESTADO EN MEMORIA ────────────────────────────────────────────────────────
// studentState[sessionId] = { socketId, studentName, matricula, examId,
//   currentQ, phase, suspicionScore, cameraOk, tokenMode,
//   lastHeartbeat, lastPhoto, answers:{} }
const studentState = {};

// Restaurar sesiones activas de SQLite al arrancar (RF-02)
(function restoreActiveSessions() {
  const active = db.getActiveSessions();
  active.forEach(s => {
    studentState[s.session_id] = {
      socketId:      null,
      studentName:   s.student_name,
      matricula:     s.matricula || '',
      examId:        s.exam_id,
      currentQ:      s.current_question,
      phase:         s.phase,
      suspicionScore: s.suspicion_score,
      cameraOk:      Boolean(s.camera_ok),
      tokenMode:     Boolean(s.token_mode),
      lastHeartbeat: Date.now(),
      lastPhoto:     null,
      answers:       db.getAnswersBySession(s.session_id)
    };
  });
  console.log(`[VORTEX] ${active.length} sesión(es) restaurada(s) desde SQLite.`);
})();

// ─── RUTAS ESTÁTICAS ─────────────────────────────────────────────────────────
app.use('/app',   express.static(path.join(STATIC_DIR, 'public')));
app.use('/admin',
  adminAuth.middleware(),
  express.static(path.join(STATIC_DIR, 'admin'))
);

// ─── AUTH ENDPOINTS ───────────────────────────────────────────────────────────

// Login: devuelve Bearer token
app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === adminAuth.password) {
    const token = adminAuth.generateToken();
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
});

// Cambio de contraseña persistente
app.post('/admin/change-password', adminAuth.middleware(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (currentPassword !== adminAuth.password) {
    return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'Nueva contraseña inválida (mínimo 6 caracteres)' });
  }
  adminAuth.updatePassword(newPassword);   // invalida todos los tokens
  db.setConfig('admin_password', newPassword);
  res.json({ ok: true, msg: 'Contraseña actualizada. Vuelve a iniciar sesión.' });
});

// ─── API REST ADMIN ───────────────────────────────────────────────────────────

// Estado general
app.get('/admin/api/state', adminAuth.middleware(), (req, res) => {
  const snapshot = Object.entries(studentState).map(([sid]) => buildStudentSnapshot(sid));
  res.json({ students: snapshot, examEngine: examEngine.getStatus() });
});

// Resultados finales
app.get('/admin/api/results', adminAuth.middleware(), (req, res) => {
  res.json({ results: db.getFinalResults() });
});

// Bitácora de sospecha
app.get('/admin/api/suspicion-log', adminAuth.middleware(), (req, res) => {
  res.json({ logs: db.getSuspicionLog() });
});

// Última foto de un alumno
app.get('/admin/api/photo/:sessionId', adminAuth.middleware(), (req, res) => {
  const photo = db.getLatestPhoto(req.params.sessionId);
  if (!photo) return res.status(404).json({ ok: false });
  res.json({ ok: true, imageData: photo.image_data, takenAt: photo.taken_at });
});

// Generar token manual (RF-03)
app.post('/admin/api/token/generate', adminAuth.middleware(), (req, res) => {
  const { sessionId } = req.body || {};
  if (!studentState[sessionId]) return res.status(404).json({ ok: false });
  const token = Math.floor(1000 + Math.random() * 9000).toString();
  db.saveToken(sessionId, token);
  res.json({ ok: true, token });
});

// ─── CSV IMPORT: PADRÓN DE ALUMNOS ───────────────────────────────────────────
// Formato CSV: nombre,matricula
app.post('/admin/api/import/students', adminAuth.middleware(), (req, res) => {
  const { csv, append } = req.body || {};
  if (!csv) return res.status(400).json({ ok: false, error: 'CSV vacío' });

  try {
    const rows = parseCSV(csv);
    if (rows.length === 0) return res.status(400).json({ ok: false, error: 'Sin filas válidas' });

    const required = ['nombre', 'matricula'];
    const headers = Object.keys(rows[0]);
    const missing = required.filter(r => !headers.includes(r));
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Columnas faltantes: ${missing.join(', ')}. Se esperan: nombre,matricula`
      });
    }

    const students = rows
      .filter(r => r.nombre && r.matricula)
      .map(r => ({ nombre: r.nombre.trim(), matricula: r.matricula.trim() }));

    if (!append) db.clearStudentRoster();
    db.importStudentRoster(students);

    console.log(`[DB] Padrón importado: ${students.length} alumno(s).`);
    res.json({ ok: true, count: students.length, total: db.getRosterCount() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── CSV IMPORT: BANCO DE PREGUNTAS ──────────────────────────────────────────
// Formato CSV: examen_titulo,pregunta,opcion_a,opcion_b,opcion_c,opcion_d,correcta
// correcta: 0=A 1=B 2=C 3=D (también acepta A/B/C/D)
app.post('/admin/api/import/exam', adminAuth.middleware(), (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ ok: false, error: 'CSV vacío' });

  try {
    const rows = parseCSV(csv);
    if (rows.length === 0) return res.status(400).json({ ok: false, error: 'Sin filas válidas' });

    const required = ['pregunta', 'opcion_a', 'opcion_b', 'opcion_c', 'opcion_d', 'correcta'];
    const headers = Object.keys(rows[0]);
    const missing = required.filter(r => !headers.includes(r));
    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Columnas faltantes: ${missing.join(', ')}. Se esperan: examen_titulo,pregunta,opcion_a,opcion_b,opcion_c,opcion_d,correcta`
      });
    }

    // Agrupar por examen_titulo
    const examGroups = {};
    rows.forEach(r => {
      const title = (r.examen_titulo || 'Examen Importado').trim();
      if (!examGroups[title]) examGroups[title] = [];
      const correctRaw = (r.correcta || '0').trim().toUpperCase();
      const correctIdx = ['A','B','C','D'].includes(correctRaw)
        ? ['A','B','C','D'].indexOf(correctRaw)
        : parseInt(correctRaw, 10) || 0;

      examGroups[title].push({
        text:    r.pregunta.trim(),
        options: [r.opcion_a, r.opcion_b, r.opcion_c, r.opcion_d].map(o => (o||'').trim()),
        correct: correctIdx
      });
    });

    const created = [];
    Object.entries(examGroups).forEach(([title, questions]) => {
      const id = `exam-csv-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      examEngine.addExam(id, title, questions);
      created.push({ id, title, questionCount: questions.length });
    });

    console.log(`[ExamEngine] ${created.length} examen(s) importado(s) desde CSV.`);
    res.json({ ok: true, exams: created, examEngine: examEngine.getStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Padrón: lista completa para el panel
app.get('/admin/api/roster', adminAuth.middleware(), (req, res) => {
  res.json({ roster: db.getAllRoster(), count: db.getRosterCount() });
});

// Redirección raíz
app.get('/', (req, res) => res.redirect('/app'));

// ─── SOCKET.IO — LÓGICA PRINCIPAL ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Conexión: ${socket.id}`);

  // ── REGISTRO DE ALUMNO ──────────────────────────────────────────────────
  socket.on('student:register', ({ studentName, matricula, sessionId }) => {
    if (Object.keys(studentState).length >= MAX_STUDENTS && !sessionId) {
      socket.emit('error', { code: 'CAPACITY_FULL', msg: 'Aforo completo' });
      return;
    }

    let sid = sessionId;
    let isReconnect = false;
    let resolvedName = (studentName || '').trim();
    const resolvedMatricula = (matricula || studentName || '').trim();

    // Si hay padrón cargado, buscar el nombre por matrícula
    if (db.getRosterCount() > 0) {
      const entry = db.lookupStudentByMatricula(resolvedMatricula);
      if (entry) {
        resolvedName = entry.nombre;
      } else if (!resolvedName) {
        socket.emit('error', {
          code: 'STUDENT_NOT_FOUND',
          msg: 'Matrícula no encontrada en el padrón. Verifica con tu profesor.'
        });
        return;
      }
    }

    if (!resolvedName) resolvedName = resolvedMatricula || 'Alumno';

    if (sid && studentState[sid]) {
      isReconnect = true;
      studentState[sid].socketId = socket.id;
      db.updateSessionSocket(sid, socket.id);
    } else {
      sid = uuidv4();
      studentState[sid] = {
        socketId:       socket.id,
        studentName:    resolvedName,
        matricula:      resolvedMatricula,
        examId:         examEngine.currentExamId,
        currentQ:       0,
        phase:          'lobby',
        suspicionScore: 0,
        cameraOk:       null,
        tokenMode:      false,
        lastHeartbeat:  Date.now(),
        lastPhoto:      null,
        answers:        {}
      };
      db.createSession(sid, studentState[sid]);
    }

    socket.data.sessionId = sid;
    socket.join('students');

    const s = studentState[sid];
    socket.emit('session:ready', {
      sessionId:   sid,
      studentName: s.studentName,
      matricula:   s.matricula,
      phase:       s.phase,
      currentQ:    s.currentQ,
      isReconnect,
      tokenMode:   s.tokenMode
    });

    io.to('admin').emit('admin:student-update', buildStudentSnapshot(sid));
    console.log(`[VORTEX] ${isReconnect ? 'Reconexión' : 'Registro'}: ${s.studentName} (${sid.slice(0,8)}…)`);
  });

  // ── CÁMARA (RF-03) ──────────────────────────────────────────────────────
  socket.on('student:camera-status', ({ status }) => {
    const sid = socket.data.sessionId;
    if (!sid || !studentState[sid]) return;
    const s = studentState[sid];

    s.cameraOk = (status === 'ok');
    if (!s.cameraOk) {
      s.tokenMode = true;
      db.updateSessionField(sid, 'camera_ok', 0);
      db.updateSessionField(sid, 'token_mode', 1);
      db.logSuspicion(sid, 'CAMERA_UNAVAILABLE', 'Cámara no disponible, activando Modo Token');
      socket.emit('session:token-mode-activated', {
        msg: 'Cámara no disponible. El profesor validará tu identidad con un código de 4 dígitos.'
      });
      io.to('admin').emit('admin:camera-alert', {
        sessionId: sid, studentName: s.studentName, reason: 'CAMERA_UNAVAILABLE'
      });
    } else {
      db.updateSessionField(sid, 'camera_ok', 1);
      photoQueue.schedulePhoto(sid, () => { socket.emit('exam:request-photo'); });
    }
    io.to('admin').emit('admin:student-update', buildStudentSnapshot(sid));
  });

  // ── FOTO (RF-01: cola desfasada) ────────────────────────────────────────
  socket.on('student:photo', ({ imageData }) => {
    const sid = socket.data.sessionId;
    if (!sid || !studentState[sid]) return;

    db.savePhoto(sid, imageData, Date.now());
    studentState[sid].lastPhoto = imageData;

    // Reenviar miniatura al dashboard admin
    io.to('admin').emit('admin:student-photo', { sessionId: sid, imageData });

    photoQueue.schedulePhoto(sid, () => { socket.emit('exam:request-photo'); });
  });

  // ── HEARTBEAT DE FOCO (RF-04) ───────────────────────────────────────────
  socket.on('student:heartbeat', ({ focus }) => {
    const sid = socket.data.sessionId;
    if (!sid || !studentState[sid]) return;
    const s = studentState[sid];
    const now   = Date.now();
    const delta = now - s.lastHeartbeat;

    if (delta > HEARTBEAT_INTERVAL_MS * 3) {
      incrementSuspicion(sid, 'HEARTBEAT_LATE', `Latido tardío: ${delta}ms`, socket);
    }
    if (!focus) {
      incrementSuspicion(sid, 'FOCUS_LOST', 'Alumno salió de la ventana del examen', socket);
    }

    s.lastHeartbeat = now;
    db.updateSessionField(sid, 'last_heartbeat', now);
  });

  // ── RESPUESTA (RF-04: lógica 100% en backend) ───────────────────────────
  socket.on('student:answer', ({ questionIndex, optionIndex }) => {
    const sid = socket.data.sessionId;
    if (!sid || !studentState[sid]) return;
    const s = studentState[sid];

    if (s.phase !== 'exam') {
      socket.emit('error', { code: 'NOT_IN_EXAM', msg: 'No hay examen activo' });
      return;
    }

    if (s.answers[questionIndex] === undefined) {
      s.answers[questionIndex] = optionIndex;
      stateSaver.saveAnswer(sid, questionIndex, optionIndex);  // RF-02: sync <5ms
    }

    const exam = examEngine.getExam(s.examId);
    if (!exam) return;
    const nextQ = questionIndex + 1;

    if (nextQ < exam.questions.length) {
      s.currentQ = nextQ;
      db.updateSessionField(sid, 'current_question', nextQ);
      const q = exam.questions[nextQ];
      // RF-04: NUNCA incluir la respuesta correcta en el payload del cliente
      socket.emit('exam:question', {
        index:   nextQ,
        total:   exam.questions.length,
        text:    q.text,
        options: q.options
      });
    } else {
      s.phase = 'finished';
      db.updateSessionField(sid, 'phase', 'finished');
      const score = examEngine.calculateScore(s.examId, s.answers);
      db.saveFinalScore(sid, score);
      photoQueue.cancel(sid);
      socket.emit('exam:finished', { score, total: exam.questions.length });
      io.to('admin').emit('admin:student-finished', {
        sessionId: sid, studentName: s.studentName, score, total: exam.questions.length
      });
    }

    io.to('admin').emit('admin:student-update', buildStudentSnapshot(sid));
  });

  // ── TOKEN MANUAL (RF-03) ────────────────────────────────────────────────
  socket.on('student:token-submit', ({ token }) => {
    const sid = socket.data.sessionId;
    if (!sid) return;
    const saved = db.getToken(sid);
    if (saved && saved === token) {
      socket.emit('token:valid');
      db.logSuspicion(sid, 'TOKEN_VALIDATED', 'Token manual validado correctamente');
    } else {
      socket.emit('token:invalid');
      incrementSuspicion(sid, 'TOKEN_WRONG', 'Token manual incorrecto ingresado', socket);
    }
  });

  // ── DESCONEXIÓN ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const sid = socket.data.sessionId;
    if (sid && studentState[sid]) {
      studentState[sid].socketId = null;
      db.updateSessionField(sid, 'socket_id', null);
      io.to('admin').emit('admin:student-disconnected', { sessionId: sid });
      console.log(`[WS] Desconexión: ${studentState[sid].studentName}`);
    }
  });

  // ── ADMIN SOCKET ────────────────────────────────────────────────────────
  socket.on('admin:join', ({ token }) => {
    if (!adminAuth.verifyToken(token)) {
      socket.emit('error', { code: 'ADMIN_AUTH_FAILED' });
      socket.disconnect();
      return;
    }
    socket.join('admin');
    const snapshot = Object.keys(studentState).map(sid => buildStudentSnapshot(sid));
    socket.emit('admin:full-state', {
      students: snapshot,
      exam:     examEngine.getStatus(),
      rosterCount: db.getRosterCount()
    });
  });

  // ── ADMIN: INICIAR EXAMEN ───────────────────────────────────────────────
  socket.on('admin:start-exam', ({ examId }, callback) => {
    if (!socket.rooms.has('admin')) return;
    const ok = examEngine.activateExam(examId);
    if (ok) {
      const exam = examEngine.getExam(examId);
      Object.entries(studentState).forEach(([sid, s]) => {
        if (s.phase === 'lobby' && s.socketId) {
          s.phase   = 'exam';
          s.currentQ = 0;
          s.examId  = examId;
          db.updateSessionField(sid, 'phase',   'exam');
          db.updateSessionField(sid, 'exam_id', examId);
          const q = exam.questions[0];
          io.to(s.socketId).emit('exam:start', {
            examTitle: exam.title, totalQuestions: exam.questions.length
          });
          io.to(s.socketId).emit('exam:question', {
            index: 0, total: exam.questions.length, text: q.text, options: q.options
          });
        }
      });
      io.to('students').emit('exam:started', { examTitle: exam.title });
      if (callback) callback({ ok: true });
    } else {
      if (callback) callback({ ok: false, error: 'Examen no encontrado' });
    }
  });

  socket.on('admin:stop-exam', (_, callback) => {
    if (!socket.rooms.has('admin')) return;
    examEngine.deactivateExam();
    io.to('students').emit('exam:stopped', { msg: 'El profesor ha detenido el examen.' });
    if (callback) callback({ ok: true });
  });

  // El admin puede pedir re-sincronización de exámenes tras importar CSV
  socket.on('admin:refresh-exams', (_, callback) => {
    if (!socket.rooms.has('admin')) return;
    socket.emit('admin:full-state', {
      students:    Object.keys(studentState).map(sid => buildStudentSnapshot(sid)),
      exam:        examEngine.getStatus(),
      rosterCount: db.getRosterCount()
    });
    if (callback) callback({ ok: true });
  });
});

// ─── HEARTBEAT WATCHDOG (RF-04) ───────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.entries(studentState).forEach(([sid, s]) => {
    if (s.socketId && s.phase === 'exam') {
      const delta = now - s.lastHeartbeat;
      if (delta > HEARTBEAT_INTERVAL_MS * 4) {
        incrementSuspicion(sid, 'HEARTBEAT_MISSING', `Sin latido por ${delta}ms`, null);
        io.to(s.socketId).emit('exam:request-heartbeat');
      }
    }
  });
}, HEARTBEAT_INTERVAL_MS);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function incrementSuspicion(sid, event, detail, socket) {
  if (!studentState[sid]) return;
  const s = studentState[sid];
  s.suspicionScore += 1;
  db.updateSessionField(sid, 'suspicion_score', s.suspicionScore);
  db.logSuspicion(sid, event, detail);

  io.to('admin').emit('admin:suspicion-alert', {
    sessionId: sid, studentName: s.studentName,
    event, detail, suspicionScore: s.suspicionScore
  });
  if (socket) {
    socket.emit('exam:warning', { msg: 'Se ha detectado actividad inusual en tu sesión.' });
  }
}

function buildStudentSnapshot(sid) {
  const s = studentState[sid];
  if (!s) return null;
  const exam = s.examId ? examEngine.getExam(s.examId) : null;
  return {
    sessionId:     sid,
    studentName:   s.studentName,
    matricula:     s.matricula || '',
    phase:         s.phase,
    currentQ:      s.currentQ,
    totalQ:        exam ? exam.questions.length : 0,
    suspicionScore: s.suspicionScore,
    cameraOk:      s.cameraOk,
    tokenMode:     s.tokenMode,
    online:        s.socketId !== null,
    answersCount:  Object.keys(s.answers).length,
    examId:        s.examId,
    lastPhoto:     s.lastPhoto || null
  };
}

// Parseo simple de CSV (sin dependencias externas)
// No soporta campos con comas internas entre comillas — suficiente para casos escolares
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   VORTEX SERVER — Puerto ${PORT}            ║`);
  console.log(`║   Admin:  http://localhost:${PORT}/admin    ║`);
  console.log(`║   Alumno: http://TU_IP:${PORT}/app         ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  try {
    const tunnelUrl = await Tunnel.start(PORT, adminAuth.password);
    if (tunnelUrl) console.log(`[TÚNEL] Acceso externo admin: ${tunnelUrl}`);
  } catch {
    console.log(`[TÚNEL] Sin internet — modo desconectado estricto.`);
  }
});

module.exports = { app, io, studentState };
