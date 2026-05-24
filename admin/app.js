/**
 * VORTEX Admin Dashboard — app.js
 * Panel de control del profesor: monitoreo en tiempo real, gestión de exámenes,
 * importación CSV, alertas de sospecha y generación de tokens manuales.
 */
'use strict';

// ── ESTADO ──────────────────────────────────────────────────────────────────
const students   = {};   // sessionId → snapshot + lastPhoto
let alertLog     = [];
let examStatus   = {};
let rosterCount  = 0;
let adminToken   = null;

// ── TOKEN DESDE COOKIE ────────────────────────────────────────────────────────
function getCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}
adminToken = getCookie('vortex_token');

// ── FETCH CON AUTH ────────────────────────────────────────────────────────────
function authFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
  return fetch(url, { ...options, headers });
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

socket.on('connect', () => {
  socket.emit('admin:join', { token: adminToken });
});

socket.on('error', ({ code }) => {
  if (code === 'ADMIN_AUTH_FAILED') {
    window.location.href = '/admin/login.html';
  }
});

socket.on('admin:full-state', ({ students: list, exam, rosterCount: rc }) => {
  list.forEach(s => { if (s) students[s.sessionId] = { ...s }; });
  examStatus  = exam || {};
  rosterCount = rc || 0;
  populateExamSelect();
  renderGrid();
  updateStats();
  updateRosterBadge();
});

socket.on('admin:student-update', (snap) => {
  if (!snap) return;
  const existing = students[snap.sessionId] || {};
  students[snap.sessionId] = { ...existing, ...snap };
  renderGrid();
  updateStats();
});

socket.on('admin:student-finished', ({ sessionId, score, total }) => {
  if (students[sessionId]) {
    students[sessionId].phase = 'finished';
    students[sessionId].score = score;
  }
  renderGrid();
  updateStats();
  updateResults();
});

socket.on('admin:student-disconnected', ({ sessionId }) => {
  if (students[sessionId]) students[sessionId].online = false;
  renderGrid();
  updateStats();
});

socket.on('admin:suspicion-alert', (payload) => {
  if (students[payload.sessionId]) {
    students[payload.sessionId].suspicionScore = payload.suspicionScore;
  }
  addAlert(payload.event, payload.studentName, payload.detail, 'sus');
  renderGrid();
  updateStats();
});

socket.on('admin:camera-alert', ({ sessionId, studentName, reason }) => {
  if (students[sessionId]) students[sessionId].tokenMode = true;
  addAlert('CAMERA_UNAVAILABLE', studentName, reason, 'camera');
  renderGrid();
  updateStats();
});

// Foto recibida: actualizar en estado y en card DOM sin re-renderizar todo
socket.on('admin:student-photo', ({ sessionId, imageData }) => {
  if (students[sessionId]) {
    students[sessionId].lastPhoto = imageData;
  }
  const img = document.getElementById(`photo-${sessionId}`);
  if (img) {
    img.src   = `data:image/jpeg;base64,${imageData}`;
    img.style.display = 'block';
  }
});

// ── RENDER GRID ───────────────────────────────────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('students-grid');
  const sorted = Object.values(students)
    .sort((a, b) => {
      // Prioridad 1: alta sospecha arriba
      const aHigh = (a.suspicionScore || 0) >= 5 ? 1 : 0;
      const bHigh = (b.suspicionScore || 0) >= 5 ? 1 : 0;
      if (bHigh !== aHigh) return bHigh - aHigh;
      // Prioridad 2: score de sospecha descendente
      return (b.suspicionScore || 0) - (a.suspicionScore || 0);
    });

  // Actualizar tarjetas existentes o crear nuevas (evita destruir imgs con foto)
  const existingIds = new Set([...grid.querySelectorAll('.student-card')].map(c => c.dataset.sid));
  const newIds = new Set(sorted.map(s => s.sessionId));

  // Eliminar tarjetas de alumnos ya no existentes
  existingIds.forEach(id => {
    if (!newIds.has(id)) {
      const el = grid.querySelector(`[data-sid="${id}"]`);
      if (el) el.remove();
    }
  });

  // Construir orden correcto
  sorted.forEach((s, idx) => {
    let card = grid.querySelector(`[data-sid="${s.sessionId}"]`);
    if (!card) {
      card = buildCard(s);
      grid.appendChild(card);
    } else {
      updateCard(card, s);
    }
    // Mantener orden visual
    if (grid.children[idx] !== card) {
      grid.insertBefore(card, grid.children[idx] || null);
    }
  });

  if (sorted.length === 0) {
    if (!grid.querySelector('.empty-msg')) {
      const p = document.createElement('p');
      p.className = 'empty-msg';
      p.style.cssText = 'color:var(--muted);font-size:.85rem;grid-column:1/-1;padding:2rem;text-align:center;';
      p.textContent = 'Sin alumnos conectados. Esperando...';
      grid.appendChild(p);
    }
  } else {
    const empty = grid.querySelector('.empty-msg');
    if (empty) empty.remove();
  }
}

function buildCard(s) {
  const div = document.createElement('div');
  div.className = cardClasses(s);
  div.dataset.sid = s.sessionId;
  div.innerHTML   = cardInnerHTML(s);
  attachCardEvents(div, s);
  return div;
}

function updateCard(card, s) {
  card.className = cardClasses(s);
  card.innerHTML = cardInnerHTML(s);
  attachCardEvents(card, s);
}

function cardClasses(s) {
  const sus = s.suspicionScore || 0;
  const cls = ['student-card'];
  if (s.online && s.phase !== 'finished') cls.push('online');
  if (!s.online) cls.push('offline');
  if (s.phase === 'finished') cls.push('finished');
  if (sus >= 5) cls.push('high-suspicion');
  else if (sus >= 2) cls.push('suspicious');
  return cls.join(' ');
}

function cardInnerHTML(s) {
  const sus      = s.suspicionScore || 0;
  const total    = s.totalQ || 0;
  const answered = s.answersCount || 0;
  const progress = total > 0 ? Math.round((answered / total) * 100) : 0;
  const phaseLabel = s.phase === 'exam'
    ? `P ${(s.currentQ || 0) + 1}/${total}`
    : s.phase.toUpperCase();

  const photoSrc = s.lastPhoto
    ? `data:image/jpeg;base64,${s.lastPhoto}`
    : '';

  return `
    <div class="sc-top">
      <div>
        <div class="sc-name">${escHtml(s.studentName)}</div>
        ${s.matricula ? `<div class="sc-mat">${escHtml(s.matricula)}</div>` : ''}
      </div>
      <div class="sc-badges">
        ${s.phase === 'finished' ? '<span class="badge ok">FIN</span>' : ''}
        ${s.tokenMode ? '<span class="badge cam-off">📷✗</span>' : '<span class="badge ok" style="font-size:.6rem">📷✓</span>'}
        ${!s.online ? '<span class="badge">OFF</span>' : ''}
      </div>
    </div>
    ${photoSrc ? `
    <div class="sc-photo-wrap">
      <img id="photo-${s.sessionId}" class="sc-photo" src="${photoSrc}" style="display:block">
    </div>` : `<div class="sc-photo-wrap">
      <img id="photo-${s.sessionId}" class="sc-photo">
    </div>`}
    <div class="sc-progress">
      <div class="sc-progress-fill" style="width:${progress}%"></div>
    </div>
    <div class="sc-meta">
      <span>${phaseLabel}</span>
      <span class="sc-suspicion ${sus >= 5 ? 'high' : sus >= 2 ? 'med' : ''}">⚑ ${sus}</span>
    </div>
  `;
}

function attachCardEvents(card, s) {
  if (s.tokenMode) {
    card.style.cursor = 'pointer';
    card.title = 'Clic para generar token de validación';
    card.addEventListener('click', () => generateToken(s.sessionId, s.studentName));
  }
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const all = Object.values(students);
  setEl('stat-online',    `${all.filter(s => s.online && s.phase !== 'finished').length} en línea`);
  setEl('stat-finished',  `${all.filter(s => s.phase === 'finished').length} terminados`);
  setEl('stat-suspicious',`${all.filter(s => (s.suspicionScore || 0) >= 2).length} alertas`);
  setEl('stat-token',     `${all.filter(s => s.tokenMode).length} sin cámara`);
  setEl('stat-total',     `${all.length} / ${MAX_EXPECTED} alumnos`);
}

const MAX_EXPECTED = 50;

function updateRosterBadge() {
  const el = document.getElementById('roster-badge');
  if (el) el.textContent = rosterCount > 0 ? `Padrón: ${rosterCount}` : 'Sin padrón';
}

// ── ALERTAS ───────────────────────────────────────────────────────────────────
function addAlert(event, name, detail, type = '') {
  const now = new Date().toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  alertLog.unshift({ event, name, detail, type, time: now });
  if (alertLog.length > 300) alertLog.pop();

  const log  = document.getElementById('alert-log');
  const empty = log.querySelector('p');
  if (empty) log.innerHTML = '';

  const item = document.createElement('div');
  item.className = `alert-item ${type}`;
  item.innerHTML = `
    <span class="alert-time">${now}</span>
    <div class="alert-name">${escHtml(name)}</div>
    <div class="alert-event">${escHtml(event)}${detail ? ' — ' + escHtml(detail) : ''}</div>
  `;
  log.prepend(item);
}

// ── RESULTADOS ────────────────────────────────────────────────────────────────
async function updateResults() {
  try {
    const res = await authFetch('/admin/api/results');
    if (!res.ok) return;
    const { results } = await res.json();
    const tbody = document.getElementById('results-body');
    tbody.innerHTML = '';
    results.forEach(r => {
      const sc  = r.final_score || 0;
      const cls = sc >= 70 ? 'good' : sc >= 50 ? 'avg' : 'bad';
      const tr  = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(r.student_name)}</td>
        <td><span class="score-chip ${cls}">${sc}%</span></td>
        <td style="color:${r.suspicion_score >= 5 ? 'var(--danger)' : r.suspicion_score >= 2 ? 'var(--warn)' : 'var(--muted)'}">${r.suspicion_score}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch { /* silencioso */ }
}

// ── EXÁMENES ──────────────────────────────────────────────────────────────────
function populateExamSelect() {
  const sel = document.getElementById('exam-select');
  sel.innerHTML = '';
  (examStatus.availableExams || []).forEach(e => {
    const opt = document.createElement('option');
    opt.value       = e.id;
    opt.textContent = `${e.title} (${e.questionCount}p)`;
    if (e.id === examStatus.currentExamId) opt.selected = true;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-start').addEventListener('click', () => {
  const examId = document.getElementById('exam-select').value;
  if (!examId) return;
  socket.emit('admin:start-exam', { examId }, (res) => {
    if (res?.ok) addAlert('EXAM_STARTED', 'Sistema', `Examen iniciado`, 'ok');
    else addAlert('EXAM_ERROR', 'Sistema', res?.error || 'Error al iniciar', 'sus');
  });
});

document.getElementById('btn-stop').addEventListener('click', () => {
  if (!confirm('¿Detener el examen para todos los alumnos?')) return;
  socket.emit('admin:stop-exam', {}, () => {
    addAlert('EXAM_STOPPED', 'Sistema', 'Examen detenido por el profesor', 'sus');
  });
});

// ── TOKEN MANUAL ──────────────────────────────────────────────────────────────
async function generateToken(sessionId, name) {
  try {
    const res  = await authFetch('/admin/api/token/generate', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modal-token-value').textContent = data.token;
      document.getElementById('modal-token-name').textContent  = name;
      document.getElementById('token-modal').classList.add('show');
      addAlert('TOKEN_GENERATED', name, `Token generado: ${data.token}`, 'token');
    }
  } catch { /* silencioso */ }
}

function closeTokenModal() {
  document.getElementById('token-modal').classList.remove('show');
}
window.closeTokenModal = closeTokenModal;

// ── EXPORTAR CSV ──────────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', async () => {
  try {
    const res     = await authFetch('/admin/api/results');
    const { results } = await res.json();
    let csv = 'Alumno,Matrícula,Score(%),Sospecha,Cámara,Modo Token\n';
    results.forEach(r => {
      csv += `"${r.student_name}","${r.matricula || ''}",${r.final_score || 0},${r.suspicion_score},${r.camera_ok === 1 ? 'Sí' : 'No'},${r.token_mode ? 'Sí' : 'No'}\n`;
    });
    downloadBlob(csv, `vortex-resultados-${today()}.csv`, 'text/csv;charset=utf-8;');
  } catch (e) { alert('Error al exportar: ' + e.message); }
});

// ── IMPORTAR CSV: ALUMNOS ─────────────────────────────────────────────────────
document.getElementById('input-students-csv').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  const text = await file.text();
  this.value = '';  // reset para permitir reimportar mismo archivo

  const append = document.getElementById('chk-append-roster')?.checked || false;
  try {
    const res  = await authFetch('/admin/api/import/students', {
      method: 'POST',
      body: JSON.stringify({ csv: text, append })
    });
    const data = await res.json();
    if (data.ok) {
      rosterCount = data.total;
      updateRosterBadge();
      addAlert('ROSTER_IMPORTED', 'Sistema',
        `${data.count} alumno(s) importado(s). Total padrón: ${data.total}`, 'ok');
      showToast(`✓ Padrón cargado: ${data.count} alumno(s)`, 'ok');
    } else {
      showToast(`✗ Error: ${data.error}`, 'danger');
    }
  } catch (e) { showToast(`✗ ${e.message}`, 'danger'); }
});

// ── IMPORTAR CSV: PREGUNTAS ───────────────────────────────────────────────────
document.getElementById('input-exam-csv').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  const text = await file.text();
  this.value = '';

  try {
    const res  = await authFetch('/admin/api/import/exam', {
      method: 'POST',
      body: JSON.stringify({ csv: text })
    });
    const data = await res.json();
    if (data.ok) {
      examStatus = data.examEngine || examStatus;
      populateExamSelect();
      const names = data.exams.map(e => `${e.title} (${e.questionCount}p)`).join(', ');
      addAlert('EXAM_IMPORTED', 'Sistema', `Examen(s) importado(s): ${names}`, 'ok');
      showToast(`✓ ${data.exams.length} examen(s) cargado(s)`, 'ok');
    } else {
      showToast(`✗ Error: ${data.error}`, 'danger');
    }
  } catch (e) { showToast(`✗ ${e.message}`, 'danger'); }
});

// Botones que abren el file picker
document.getElementById('btn-import-students').addEventListener('click', () => {
  document.getElementById('input-students-csv').click();
});
document.getElementById('btn-import-exam').addEventListener('click', () => {
  document.getElementById('input-exam-csv').click();
});

// ── CAMBIAR CONTRASEÑA ────────────────────────────────────────────────────────
document.getElementById('btn-change-pass').addEventListener('click', () => {
  document.getElementById('pass-modal').classList.add('show');
  document.getElementById('pass-current').value = '';
  document.getElementById('pass-new').value     = '';
  document.getElementById('pass-confirm').value = '';
  document.getElementById('pass-error').textContent = '';
});

function closePassModal() {
  document.getElementById('pass-modal').classList.remove('show');
}
window.closePassModal = closePassModal;

document.getElementById('btn-save-pass').addEventListener('click', async () => {
  const current = document.getElementById('pass-current').value;
  const newPass = document.getElementById('pass-new').value;
  const confirm = document.getElementById('pass-confirm').value;
  const errEl   = document.getElementById('pass-error');

  if (!current || !newPass) { errEl.textContent = 'Completa todos los campos.'; return; }
  if (newPass !== confirm)   { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  if (newPass.length < 6)    { errEl.textContent = 'Mínimo 6 caracteres.'; return; }

  try {
    const res  = await authFetch('/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: newPass })
    });
    const data = await res.json();
    if (data.ok) {
      closePassModal();
      alert('Contraseña actualizada. Se cerrará tu sesión, vuelve a ingresar.');
      document.cookie = 'vortex_token=; path=/; max-age=0';
      window.location.href = '/admin/login.html';
    } else {
      errEl.textContent = data.error || 'Error al cambiar contraseña.';
    }
  } catch (e) { errEl.textContent = 'Error de red.'; }
});

// ── TABS SIDEBAR ──────────────────────────────────────────────────────────────
document.querySelectorAll('.stab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
    if (tab.dataset.panel === 'results') updateResults();
  });
});

// Cerrar modales haciendo clic afuera
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('show');
    }
  });
});

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'ok') {
  let toast = document.getElementById('admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-toast';
    toast.style.cssText = `
      position:fixed;bottom:1.5rem;right:1.5rem;z-index:300;
      background:var(--surface);border:1px solid var(--border);
      border-radius:8px;padding:.65rem 1.1rem;font-size:.82rem;
      font-family:var(--font-mono);box-shadow:0 4px 20px rgba(0,0,0,.4);
      transition:opacity .3s;
    `;
    document.body.appendChild(toast);
  }
  toast.style.borderColor = type === 'ok' ? 'var(--ok)' : 'var(--danger)';
  toast.style.color       = type === 'ok' ? 'var(--ok)' : 'var(--danger)';
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Polling de resultados cada 20s
setInterval(updateResults, 20000);
