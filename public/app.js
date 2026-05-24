/**
 * VORTEX PWA Client — app.js
 * RF-03: Graceful degradation si cámara falla
 * RF-04: Heartbeat de foco cada 2s + detección de onblur/visibilitychange
 * RF-02: Guarda sessionId en localStorage para reconexión post-apagón
 */

'use strict';

// ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
const state = {
  sessionId:  localStorage.getItem('vortex_session') || null,
  studentName: '',
  matricula:  '',
  phase:      'register',
  currentQ:   0,
  totalQ:     0,
  stream:     null,
  heartbeatTimer: null,
  socket:     null
};

// ── SOCKET.IO ────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'], reconnectionDelay: 1000 });
state.socket = socket;

// ── DOM REFS ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  register: $('screen-register'),
  waiting:  $('screen-waiting'),
  exam:     $('screen-exam'),
  result:   $('screen-result')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name]?.classList.add('active');
  state.phase = name;
}

// ── CONEXIÓN ─────────────────────────────────────────────────────────────────
socket.on('connect', () => {
  setStatus('ok', 'En línea');
  // Reconexión automática si hay sesión guardada
  if (state.sessionId) {
    socket.emit('student:register', {
      sessionId: state.sessionId,
      studentName: state.studentName
    });
  }
});

socket.on('disconnect', () => setStatus('danger', 'Sin conexión'));
socket.on('connect_error', () => setStatus('warn', 'Reintentando...'));

function setStatus(cls, label) {
  const dot = $('conn-dot');
  dot.className = `v-status-dot ${cls}`;
  $('conn-label').textContent = label;
}

// ── REGISTRO ──────────────────────────────────────────────────────────────────
$('btn-register').addEventListener('click', () => {
  const input = $('input-name').value.trim();
  if (!input || input.length < 2) {
    $('register-error').textContent = 'Ingresa tu matrícula o nombre completo.';
    return;
  }
  state.matricula  = input;
  state.studentName = input;
  $('btn-register').disabled = true;
  $('register-error').textContent = '';
  // Enviamos como 'matricula'; el servidor resuelve el nombre desde el padrón si existe
  socket.emit('student:register', {
    studentName: input,
    matricula:   input,
    sessionId:   state.sessionId
  });
});

$('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-register').click();
});

socket.on('session:ready', ({ sessionId, studentName, phase, currentQ, isReconnect, tokenMode }) => {
  state.sessionId = sessionId;
  state.studentName = studentName;
  localStorage.setItem('vortex_session', sessionId);

  $('waiting-name').textContent = studentName;

  if (isReconnect && phase === 'exam') {
    state.currentQ = currentQ;
    showScreen('waiting'); // el servidor re-enviará la pregunta
  } else if (phase === 'lobby') {
    showScreen('waiting');
  } else if (phase === 'finished') {
    showScreen('result');
  } else {
    showScreen('waiting');
  }

  // RF-03: Solicitar cámara
  if (tokenMode) {
    handleTokenMode();
  } else {
    requestCamera();
  }

  startHeartbeat();
});

socket.on('error', ({ code, msg }) => {
  $('btn-register').disabled = false;
  if (code === 'CAPACITY_FULL') {
    $('register-error').textContent = 'El aula está llena. Intenta en unos minutos.';
  } else if (code === 'STUDENT_NOT_FOUND') {
    $('register-error').textContent = msg || 'Matrícula no encontrada. Verifica con tu profesor.';
  } else if (msg) {
    $('register-error').textContent = msg;
  }
});

// ── CÁMARA (RF-03) ────────────────────────────────────────────────────────────
async function requestCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 160, height: 120, facingMode: 'user' },
      audio: false
    });
    state.stream = stream;
    const video = $('camera-preview');
    video.srcObject = stream;
    socket.emit('student:camera-status', { status: 'ok' });
  } catch (err) {
    console.warn('[VORTEX] Cámara no disponible:', err.message);
    socket.emit('student:camera-status', { status: 'error', reason: err.message });
    handleTokenMode();
  }
}

function capturePhoto() {
  if (!state.stream) return null;
  const video  = $('camera-preview');
  const canvas = $('camera-canvas');
  canvas.width  = 160;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 160, 120);
  // JPEG calidad 0.4 → ~8-12KB → bajo impacto en 2.4GHz
  return canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
}

socket.on('exam:request-photo', () => {
  const photo = capturePhoto();
  if (photo) socket.emit('student:photo', { imageData: photo });
});

// ── TOKEN MODE (RF-03) ────────────────────────────────────────────────────────
function handleTokenMode() {
  $('token-box').style.display = 'block';
}

socket.on('session:token-mode-activated', ({ msg }) => {
  handleTokenMode();
  showToast('⚠️ ' + msg, 5000);
});

$('token-submit').addEventListener('click', () => {
  const token = $('token-input').value.trim();
  if (token.length !== 4) return;
  socket.emit('student:token-submit', { token });
});

socket.on('token:valid', () => {
  $('token-box').style.display = 'none';
  showToast('✓ Identidad verificada', 2000);
});

socket.on('token:invalid', () => {
  $('token-input').value = '';
  showToast('Token incorrecto. Solicita uno nuevo al profesor.', 3000);
});

// ── HEARTBEAT DE FOCO (RF-04) ─────────────────────────────────────────────────
function startHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    const focus = document.visibilityState === 'visible' && !document.hidden;
    socket.emit('student:heartbeat', { focus });
  }, 2000);
}

// RF-04: Detectar pérdida de foco
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    socket.emit('student:heartbeat', { focus: false });
  }
});
window.addEventListener('blur', () => {
  socket.emit('student:heartbeat', { focus: false });
});

// RF-04: El servidor puede pedir heartbeat explícito
socket.on('exam:request-heartbeat', () => {
  const focus = document.visibilityState === 'visible' && !document.hidden;
  socket.emit('student:heartbeat', { focus });
});

// ── EXAMEN ────────────────────────────────────────────────────────────────────
socket.on('exam:started', ({ examTitle }) => {
  // El servidor enviará la primera pregunta inmediatamente
});

socket.on('exam:start', ({ examTitle, totalQuestions }) => {
  state.totalQ = totalQuestions;
  showScreen('exam');
});

const LETTERS = ['A','B','C','D'];

socket.on('exam:question', ({ index, total, text, options }) => {
  state.currentQ = index;
  state.totalQ   = total;

  $('q-number').textContent = `Pregunta ${index + 1} de ${total}`;
  $('q-text').textContent = text;
  $('progress-label').textContent = `${index + 1}/${total}`;
  $('progress-fill').style.width = `${((index) / total) * 100}%`;

  const container = $('options-container');
  container.innerHTML = '';

  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `<span class="option-letter">${LETTERS[i]}</span><span>${opt}</span>`;
    btn.addEventListener('click', () => {
      if (btn.classList.contains('selected')) return;
      // Marcar selección visualmente
      container.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Deshabilitar todas las opciones para evitar doble envío
      container.querySelectorAll('.option-btn').forEach(b => b.disabled = true);
      // Enviar respuesta al servidor (RF-04: lógica en backend)
      socket.emit('student:answer', { questionIndex: index, optionIndex: i });
    });
    container.appendChild(btn);
  });

  showScreen('exam');
});

socket.on('exam:finished', ({ score, total }) => {
  clearInterval(state.heartbeatTimer);
  localStorage.removeItem('vortex_session');
  showFinalScore(score, total);
});

socket.on('exam:stopped', ({ msg }) => {
  showToast('⏸ ' + msg, 0);
});

// RF-04: Advertencia del servidor
socket.on('exam:warning', ({ msg }) => {
  showToast('⚠️ ' + msg, 4000);
});

// ── RESULTADO ─────────────────────────────────────────────────────────────────
function showFinalScore(score, total) {
  showScreen('result');
  $('score-value').textContent = `${score}%`;
  $('result-title').textContent = score >= 70
    ? '¡Excelente resultado!'
    : score >= 50 ? 'Resultado aceptable' : 'Necesitas mejorar';
  $('result-msg').textContent =
    `Respondiste correctamente ${Math.round(score * total / 100)} de ${total} preguntas.`;

  // Animar el anillo
  const circle = $('score-circle');
  const circumference = 2 * Math.PI * 70; // r=70
  const dashoffset = circumference * (1 - score / 100);
  circle.style.strokeDasharray = circumference;
  circle.style.stroke = score >= 70
    ? 'var(--ok)'
    : score >= 50 ? 'var(--warn)' : 'var(--danger)';
  setTimeout(() => {
    circle.style.strokeDashoffset = dashoffset;
  }, 100);
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, duration = 3000) {
  const t = $('warning-toast');
  t.textContent = msg;
  t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  if (duration > 0) {
    _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  }
}

// ── PROTECCIÓN CONSOLA (RF-04) ────────────────────────────────────────────────
// Detectar si se abre DevTools (heurística de tamaño de ventana)
let _devtoolsOpen = false;
const _threshold = 160;
function checkDevTools() {
  const widthDiff  = window.outerWidth  - window.innerWidth;
  const heightDiff = window.outerHeight - window.innerHeight;
  const open = widthDiff > _threshold || heightDiff > _threshold;
  if (open && !_devtoolsOpen) {
    _devtoolsOpen = true;
    socket.emit('student:heartbeat', { focus: false });
  }
  _devtoolsOpen = open;
}
setInterval(checkDevTools, 1500);

// Deshabilitar menú contextual en modo examen
document.addEventListener('contextmenu', e => {
  if (state.phase === 'exam') e.preventDefault();
});
