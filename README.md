# VORTEX — Sistema de Evaluación Escolar Edge
## Guía de Despliegue Completa · Versión 1.0

```
╔══════════════════════════════════════════════════════════════╗
║   VORTEX — Red Local Desconectada · 50 Alumnos Simultáneos   ║
║   Backend: Node.js + Express + Socket.io + SQLite            ║
║   Cliente:  PWA (HTML5 + Vanilla JS) · Sin instalación       ║
╚══════════════════════════════════════════════════════════════╝
```

---

## ÍNDICE

1. [Auditoría de Riesgos y Mitigaciones](#1-auditoría-de-riesgos-y-mitigaciones)
2. [Requisitos del Sistema](#2-requisitos-del-sistema)
3. [Configuración del Router Netis WF2411](#3-configuración-del-router-netis-wf2411)
4. [Instalación y Arranque](#4-instalación-y-arranque)
5. [Compilar Ejecutables Portátiles (pkg)](#5-compilar-ejecutables-portátiles-pkg)
6. [Guía de Uso del Dashboard Admin](#6-guía-de-uso-del-dashboard-admin)
7. [Arquitectura Técnica](#7-arquitectura-técnica)
8. [Solución de Problemas](#8-solución-de-problemas)

---

## 1. AUDITORÍA DE RIESGOS Y MITIGACIONES

### RF-01 · Saturación Inalámbrica (50 usuarios · Banda 2.4GHz)

| Aspecto | Problema | Mitigación implementada |
|---------|----------|------------------------|
| **Cola fotográfica** | 50 timers simultáneos dispararían en el mismo ms | `PhotoQueue` con jitter aleatorio ±1s sobre base de 9s → distribución uniforme en ventana de 2s |
| **Payload WebSocket** | Frames de cámara sin comprimir colapsan el canal | JPEG calidad 0.4 → ~8-12KB/foto · Resolución 160×120px |
| **Buffer Socket.io** | Mensajes grandes bloquean el hilo de red | `maxHttpBufferSize: 100KB` · Compresión HTTP (`gzip`) activa |
| **Protocolo** | HTTP polling más costoso que WebSocket puro | Forzado `transports: ['websocket']` en cliente y servidor |

**Cálculo de ancho de banda (peor caso):**
- 50 alumnos × 12KB/foto ÷ 2s de ventana = ~300KB/s de subida
- Netis WF2411: ~3Mbps efectivo 2.4GHz en entorno escolar
- Margen disponible para heartbeats + respuestas: ~97% del canal libre ✓

---

### RF-02 · Pérdida de Suministro / Apagón del Servidor

**Mecanismo State Saver transaccional:**

```
Alumno envía respuesta
        ↓
  socket.on('student:answer')  [RAM — <1ms]
        ↓
  stateSaver.saveAnswer()      [SQLite WAL síncrono — <5ms típico]
        ↓
  ACK confirmado               [total: <10ms]
```

- `better-sqlite3` opera en modo **síncrono** (sin callbacks/promesas) → escritura garantizada antes de enviar ACK
- SQLite en modo **WAL** (Write-Ahead Log): las escrituras no bloquean lecturas
- Al arrancar, `restoreActiveSessions()` reconstruye `studentState{}` desde SQLite automáticamente
- El alumno reconecta enviando su `sessionId` guardado en `localStorage` → retoma en la pregunta exacta

**Garantía de durabilidad:** Si el servidor cae entre la escritura SQLite y el ACK al cliente (ventana <5ms), la respuesta ya está en disco. El alumno simplemente reenvía al reconectar.

---

### RF-03 · Fallas de Instalación / Cámara no Disponible

**Árbol de decisión Graceful Degradation:**

```
Alumno conecta PWA
        ↓
navigator.mediaDevices.getUserMedia()
        ├─ Éxito → Modo Normal (capturas periódicas)
        └─ Error (denegado / roto / iOS restrictivo)
               ↓
        socket.emit('student:camera-status', { status: 'error' })
               ↓
        Servidor activa tokenMode=true para esa sesión
               ↓
        Admin recibe alerta "admin:camera-alert" con nombre del alumno
               ↓
        Admin genera token de 4 dígitos desde el dashboard
               ↓
        Dicta el token al alumno verbalmente
               ↓
        Alumno ingresa token → validación manual
```

- **Sin APK nativa**: la PWA se abre directamente desde el navegador del teléfono del alumno
- **URL de acceso**: `http://192.168.1.50:3000/app` (el alumno escanea un QR proyectado en pantalla)

---

### RF-04 · Evasión de Seguridad (Trampas)

**Principio fundamental:** Toda la lógica de evaluación vive en el servidor. El cliente es un terminal tonto.

| Vector de trampa | Mitigación |
|-----------------|------------|
| Inspeccionar JSON para ver respuestas | `questions[].correct` NUNCA se envía al cliente |
| DevTools abierto | Heurística `outerWidth - innerWidth > 160px` → heartbeat negativo |
| `window.onblur` / cambio de pestaña | Detectado y reportado como `FOCUS_LOST` |
| Script JS simulando foco continuo | Heartbeat cada 2s; si llega tarde (`delta > 6s`), `HEARTBEAT_LATE` |
| Sin heartbeat (script bloqueado) | Watchdog servidor: si sin latido por >8s, `HEARTBEAT_MISSING` |
| Menú contextual / copy | `contextmenu` deshabilitado durante el examen |

**Score de Sospecha:** Acumulador entero. Umbrales visuales en el dashboard:
- `0–1`: Normal (sin indicador)
- `2–4`: Amber (tarjeta naranja en dashboard)
- `5+`: Rojo parpadeante (alerta crítica al profesor)

---

### RF-05 · Acceso Externo Seguro (Edge-to-Cloud)

**Proceso de detección automática:**

```
Servidor arranca
        ↓
fetch('https://1.1.1.1', { timeout: 3000 })
        ├─ Sin internet → "Modo Desconectado Estricto" · Todo local
        └─ Con internet
               ↓
        Intento 1: cloudflared (si está instalado en el sistema)
               ↓
        Intento 2: localtunnel (vía npm, sin binario externo)
               ↓
        URL del túnel impresa en consola + log del servidor
               ↓
        URL apunta a /admin con autenticación Bearer Token
               ↓
        Alumnos en red local siguen usando /app directamente
```

- El túnel expone **únicamente** `/admin`, no `/app`
- Los tokens de admin duran 24h y se generan vía `POST /admin/login`
- Los alumnos en la LAN nunca conocen la URL del túnel

---

## 2. REQUISITOS DEL SISTEMA

### Servidor (laptop del profesor)
| Componente | Mínimo | Recomendado |
|-----------|--------|-------------|
| OS | Windows 10 / Ubuntu 20.04 | Windows 11 / Ubuntu 22.04 |
| RAM | 2GB libre | 4GB+ |
| CPU | Dual-core 2GHz | Quad-core 2.5GHz+ |
| Almacenamiento | 200MB libre | 1GB+ (para fotos en SQLite) |
| Node.js | v18.x | v20.x LTS |
| Conectividad | WiFi o Ethernet al router | Ethernet recomendado |

### Clientes (alumnos)
- **Cualquier smartphone** con navegador moderno (Chrome, Safari, Firefox, Edge)
- **Android 8+** o **iOS 13+**
- **Conexión al SSID del router** (sin internet necesario)
- **Sin instalación de apps** requerida

---

## 3. CONFIGURACIÓN DEL ROUTER NETIS WF2411

> Accede al panel de administración del router desde: `http://192.168.1.1`
> Usuario por defecto: `admin` · Contraseña: `admin`

### Paso 1: Configurar SSID del Examen

1. Ve a **Wireless → Basic Settings**
2. Configura:
   - **SSID:** `VORTEX-EXAMEN` (sin espacios, sin caracteres especiales)
   - **Channel:** Manual → Selecciona el canal menos congestionado (usa una app como WiFi Analyzer para verificar). Canal 1, 6 u 11 son los únicos no superpuestos.
   - **Mode:** 802.11n (para mejor rendimiento a 2.4GHz)
   - **Channel Bandwidth:** 40MHz si tu entorno lo permite, 20MHz si hay mucha interferencia
3. Haz clic en **Save**

### Paso 2: DHCP IP Binding (Fijar IP del servidor)

> **Objetivo:** Que la laptop del profesor siempre obtenga la IP `192.168.1.50`

1. Obtén la dirección MAC de la laptop del profesor:
   - **Windows:** `ipconfig /all` → busca "Dirección física" del adaptador WiFi/Ethernet
   - **Linux:** `ip link show` → busca `link/ether`
2. En el router: **DHCP → Address Reservation**
3. Clic en **Add New** y configura:
   - **MAC Address:** `XX:XX:XX:XX:XX:XX` (la MAC de la laptop)
   - **Reserved IP:** `192.168.1.50`
   - **Status:** Enabled
4. Haz clic en **Save** y **Reboot** el router

### Paso 3: Rango DHCP para Alumnos

1. Ve a **DHCP → DHCP Settings**
2. Configura:
   - **Start IP:** `192.168.1.100`
   - **End IP:** `192.168.1.199`
   - **Lease Time:** `120` minutos (evita reasignaciones durante el examen)
   - **Default Gateway:** `192.168.1.1`
3. Haz clic en **Save**

Esto reserva 100 IPs para alumnos (suficiente para 50 con margen).

### Paso 4: Seguridad WiFi

1. Ve a **Wireless → Wireless Security**
2. Configura:
   - **Security Type:** WPA2-PSK
   - **Encryption:** AES
   - **Password:** Una contraseña simple para el día del examen (ej. `examen2025`)
3. Haz clic en **Save**

> **Tip:** Proyecta el SSID y contraseña en la pantalla al inicio del examen para que todos se conecten simultáneamente.

### Paso 5: Verificar Aislamiento de Clientes (Opcional pero recomendado)

Si el router lo soporta (Netis WF2411 tiene opción limitada):
1. Ve a **Advanced → AP Isolation**
2. Activa si está disponible — evita que alumnos se comuniquen entre sí por WiFi

### Paso 6: QR Code para los Alumnos

Genera un QR con la URL del servidor y proyéctala:

```
http://192.168.1.50:3000/app
```

Puedes usar [qr-code-generator.com](https://www.qr-code-generator.com) para crear el QR en casa antes del examen.

---

## 4. INSTALACIÓN Y ARRANQUE

### Instalación (primera vez)

```bash
# Clonar o copiar el directorio vortex-server
cd vortex-server

# Instalar dependencias
npm install

# (Opcional) Configurar contraseña admin
# Windows:
set ADMIN_PASS=mi-contraseña-secreta
# Linux/Mac:
export ADMIN_PASS=mi-contraseña-secreta
```

### Arranque del servidor

```bash
# Modo producción
npm start

# Modo desarrollo (recarga automática)
npm run dev
```

### Verificar que todo funciona

Al arrancar verás en la consola:

```
╔══════════════════════════════════════════╗
║   VORTEX SERVER — Puerto 3000            ║
║   Dashboard admin: http://localhost:3000/admin ║
║   PWA Alumno:      http://TU_IP:3000/app   ║
╚══════════════════════════════════════════╝

[DB] SQLite abierta: .../database/vortex.db
[DB] Examen de demo insertado.
[ExamEngine] 1 examen(s) cargado(s).
[VORTEX] 0 sesiones restauradas desde SQLite.
[TÚNEL] Sin internet — modo desconectado estricto activado.
```

### Acceder al Dashboard Admin

1. Abre: `http://192.168.1.50:3000/admin`
2. Ingresa la contraseña admin (por defecto: `vortex-admin-2025`)
3. El sistema guarda el token en cookie por 24h

---

## 5. COMPILAR EJECUTABLES PORTÁTILES (PKG)

Esto genera archivos `.exe` (Windows) y binarios (Linux) que incluyen Node.js embebido. No se requiere instalar Node.js en la laptop del profesor.

```bash
# Instalar pkg globalmente
npm install -g pkg

# Compilar para Windows y Linux
npm run build:all

# Los archivos se generan en:
# dist/vortex-windows.exe
# dist/vortex-linux
```

### Uso desde USB (modo portátil)

1. Copia `dist/vortex-windows.exe` (o `vortex-linux`) a una USB
2. Copia también la carpeta `database/` a la USB (para persistir datos entre sesiones)
3. En la laptop del profesor:
   - Windows: doble clic en `vortex-windows.exe`
   - Linux: `chmod +x vortex-linux && ./vortex-linux`

> **Nota:** El ejecutable busca la carpeta `database/` en el mismo directorio donde se ejecuta.

---

## 6. GUÍA DE USO DEL DASHBOARD ADMIN

### Pantalla principal

- **Topbar:** Estadísticas en tiempo real (en línea / terminados / alertas / sin cámara)
- **Grid de alumnos:** Tarjetas ordenadas por Score de Sospecha (mayor sospecha arriba)
  - 🟢 Verde: alumno activo sin anomalías
  - 🟡 Naranja: 2-4 eventos de sospecha
  - 🔴 Rojo parpadeante: 5+ eventos (requiere atención inmediata)
  - ⬜ Gris: desconectado
  - 📷✗: alumno en Modo Token (sin cámara)

### Iniciar un examen

1. Selecciona el examen en el selector del topbar
2. Haz clic en **▶ Iniciar**
3. Todos los alumnos en la sala de espera recibirán la primera pregunta automáticamente

### Generar token para alumno sin cámara

1. Identifica las tarjetas con el badge `📷✗`
2. Haz clic en la tarjeta → aparece el modal con el token de 4 dígitos
3. Dicta el código verbalmente al alumno
4. El alumno lo ingresa en su pantalla → validación confirmada

### Exportar resultados

- Haz clic en **⬇ Exportar CSV** en el topbar
- Se descarga un archivo `vortex-resultados-YYYY-MM-DD.csv` con:
  - Nombre del alumno
  - Score (%)
  - Score de Sospecha
  - Estado de cámara
  - Si usó Modo Token

### Tab Alertas (sidebar)

Registro cronológico de todos los eventos de sospecha:
- `FOCUS_LOST`: alumno cambió de pestaña o minimizó
- `HEARTBEAT_LATE`: latido llegó tarde (posible script de simulación)
- `HEARTBEAT_MISSING`: sin latido por >8s
- `CAMERA_UNAVAILABLE`: cámara no accesible
- `TOKEN_WRONG`: token manual incorrecto
- `TOKEN_VALIDATED`: identidad confirmada por token

---

## 7. ARQUITECTURA TÉCNICA

```
┌─────────────────────────────────────────────────────────────┐
│                    LAPTOP DEL PROFESOR                       │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   VORTEX SERVER                       │  │
│  │                                                       │  │
│  │  Express HTTP (:3000)                                 │  │
│  │    ├── /app/*     → PWA del alumno (estático)         │  │
│  │    ├── /admin/*   → Dashboard (autenticado)           │  │
│  │    └── /admin/api → REST endpoints                    │  │
│  │                                                       │  │
│  │  Socket.io WS                                         │  │
│  │    ├── Namespace students  (50 conexiones)            │  │
│  │    └── Namespace admin     (1 conexión profesor)      │  │
│  │                                                       │  │
│  │  SQLite (better-sqlite3 síncrono)                     │  │
│  │    └── database/vortex.db                             │  │
│  │                                                       │  │
│  │  Módulos                                              │  │
│  │    ├── ExamEngine    (lógica de negocio)               │  │
│  │    ├── StateSaver    (persistencia <100ms)             │  │
│  │    ├── PhotoQueue    (cola con jitter)                 │  │
│  │    ├── AdminAuth     (Bearer Token)                   │  │
│  │    └── Tunnel        (Edge-to-Cloud opcional)         │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                   │
│                    Ethernet/WiFi                             │
└──────────────────────────│──────────────────────────────────┘
                           │
                   ┌───────┴───────┐
                   │  ROUTER NETIS │
                   │   WF2411      │
                   │  192.168.1.1  │
                   └───────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         📱 Alumno    📱 Alumno    📱 Alumno
         .100          .101        ...199
         PWA /app      PWA /app    PWA /app
```

### Flujo de datos (respuesta de alumno)

```
Alumno toca opción
      ↓
socket.emit('student:answer', { questionIndex: N, optionIndex: M })
      ↓
[SERVIDOR] valida sessionId, verifica fase 'exam'
      ↓
stateSaver.saveAnswer() → SQLite WAL sync (<5ms)
      ↓
examEngine.calculateScore() si es la última pregunta
      ↓
socket.emit('exam:question', { ...sin correct... })
      ↓
io.to('admin').emit('admin:student-update', snapshot)
```

---

## 8. SOLUCIÓN DE PROBLEMAS

### Los alumnos no pueden conectarse al servidor

```bash
# Verificar que el servidor está corriendo
# En Windows: buscar ventana de terminal con "VORTEX SERVER"

# Verificar IP de la laptop
ipconfig           # Windows
ip addr show       # Linux

# La laptop debe tener IP 192.168.1.50 (configurada por DHCP Binding)
# Si no, asignarla manualmente:
# Panel de control → Red → IPv4 → Manual: 192.168.1.50 / 255.255.255.0 / GW: 192.168.1.1
```

### El firewall de Windows bloquea el servidor

```
Panel de control → Firewall de Windows Defender
→ Permitir una aplicación a través del firewall
→ Agregar: Node.js (o el .exe compilado)
→ Marcar tanto Privada como Pública
```

O desde PowerShell (admin):
```powershell
New-NetFirewallRule -DisplayName "VORTEX" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

### Los alumnos no cargan la PWA (página en blanco)

1. Verifica que el URL es correcto: `http://192.168.1.50:3000/app` (no HTTPS)
2. Algunos navegadores de Android bloquean el primer acceso — intenta con Chrome
3. Si usas iOS/Safari: Settings → Safari → Advanced → desactiva "Prevent Cross-Site Tracking" temporalmente

### La cámara no funciona en iOS

iOS Safari requiere HTTPS para acceder a la cámara excepto en `localhost`. Para uso en red local sin HTTPS, la degradación a Modo Token se activa automáticamente. Es el comportamiento esperado del sistema.

**Solución alternativa (avanzada):** Configurar un certificado SSL auto-firmado y servir por HTTPS. Documentado en solicitud separada.

### El servidor no restaura sesiones al reiniciar

Verifica que el archivo `database/vortex.db` no fue movido o borrado. Si el ejecutable está en USB, asegúrate de que la carpeta `database/` esté en el mismo directorio que el ejecutable.

### El túnel externo no funciona

El sistema entra en modo desconectado automáticamente — no es un error. Solo el acceso externo del consultor no está disponible. El examen funciona normalmente en la red local.

---

## VARIABLES DE ENTORNO

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor HTTP |
| `ADMIN_PASS` | `vortex-admin-2025` | Contraseña del panel admin |

---

## LICENCIA

VORTEX es un sistema propietario desarrollado para uso interno. Todos los derechos reservados.
