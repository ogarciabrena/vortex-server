<p align="center">
  <pre>
╔══════════════════════════════════════════════════════════╗
║  ██╗   ██╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗   ║
║  ██║   ██║██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝   ║
║  ██║   ██║██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝    ║
║  ╚██╗ ██╔╝██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗    ║
║   ╚████╔╝ ╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗   ║
║    ╚═══╝   ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ║
║          Sistema de Evaluación Escolar Edge              ║
╚══════════════════════════════════════════════════════════╝
  </pre>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white"/>
  <img src="https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white"/>
  <img src="https://img.shields.io/badge/Socket.io-4.7-010101?style=for-the-badge&logo=socket.io&logoColor=white"/>
  <img src="https://img.shields.io/badge/PWA-offline-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white"/>
  <img src="https://img.shields.io/badge/plataforma-Linux%20%7C%20Windows-blue?style=for-the-badge"/>
</p>

<p align="center">
  Sistema de examen escolar que funciona <strong>sin internet</strong>, desde una USB.<br/>
  El profesor ejecuta un solo archivo. Los alumnos se conectan desde el navegador de su celular.
</p>

<p align="center">
  <a href="https://github.com/ogarciabrena/vortex-server/releases/tag/v1.0.0"><strong>⬇ Descargar v1.0.0</strong></a>
  &nbsp;·&nbsp;
  <a href="#instalación-rápida">Instalación rápida</a>
  &nbsp;·&nbsp;
  <a href="#arquitectura">Arquitectura</a>
  &nbsp;·&nbsp;
  <a href="#solución-de-problemas">Solución de problemas</a>
</p>

---

## ¿Qué es VORTEX?

VORTEX es un servidor de evaluaciones diseñado para aulas sin conexión a internet. Corre en la laptop del profesor y los alumnos acceden desde **cualquier navegador moderno** — sin instalar nada.

| | |
|---|---|
| 👨‍🏫 **Para el profesor** | Panel admin en tiempo real con foto y score de sospecha por alumno |
| 📱 **Para el alumno** | PWA que funciona desde el celular, sin descarga de apps |
| 🔌 **Sin internet** | Funciona en red local WiFi, incluso sin router con acceso a internet |
| 💾 **Sin pérdidas** | Cada respuesta se guarda en SQLite antes de confirmar al cliente |
| 📦 **Sin instalación** | Binario portátil de 30MB — copia y ejecuta desde USB |

---

## Descarga rápida

| Plataforma | Archivo | Tamaño |
|------------|---------|--------|
| 🐧 Linux x64 | [VORTEX-linux-x64.zip](https://github.com/ogarciabrena/vortex-server/releases/latest/download/VORTEX-linux-x64.zip) | ~33 MB |
| 🪟 Windows x64 | [VORTEX-windows-x64.zip](https://github.com/ogarciabrena/vortex-server/releases/latest/download/VORTEX-windows-x64.zip) | ~27 MB |

> Los binarios incluyen Node.js embebido. No se requiere instalación previa.

---

## Instalación rápida

### Opción A — Binario portátil (recomendado para producción)

```bash
# Linux
unzip VORTEX-linux-x64.zip
chmod +x vortex-linux
./vortex-linux
```

```powershell
# Windows — doble clic en vortex-windows.exe
# O desde PowerShell:
.\vortex-windows.exe
```

La carpeta `database/` se crea automáticamente al lado del ejecutable.

### Opción B — Desde el código fuente

```bash
git clone https://github.com/ogarciabrena/vortex-server
cd vortex-server
npm install
npm start
```

### Acceder al sistema

| URL | Descripción |
|-----|-------------|
| `http://localhost:3000/admin` | Panel de administrador |
| `http://TU_IP:3000/app` | Portal del alumno (desde cualquier dispositivo en la red) |

**Contraseña por defecto:** `vortex-admin-2025`

> Cámbiala desde el panel admin → icono 🔑 en el topbar. Se persiste en la base de datos.

---

## Funcionalidades

### Panel de administrador

- **Grid reactivo** de hasta 50 alumnos con actualización en tiempo real
- **Foto de verificación** por alumno (captura periódica desde la cámara del celular)
- **Score de sospecha** visual: verde → naranja → 🔴 rojo parpadeante
- **Importar padrón** vía CSV (`nombre,matricula`)
- **Importar banco de preguntas** vía CSV (`examen_titulo,pregunta,opcion_a–d,correcta`)
- **Exportar resultados** a CSV con score, sospecha y estado de cámara
- **Modo Token** para alumnos sin cámara: genera código de 4 dígitos para validación manual

### Portal del alumno

- PWA instalable (funciona offline una vez cargada)
- Login por matrícula — validado contra padrón importado
- Verificación por cámara con degradación automática a Modo Token
- Anti-trampa: detecta cambio de pestaña, pérdida de foco, DevTools abierto, heartbeat tardío
- Reconexión automática con restauración de sesión exacta

### Motor de examen

- Las respuestas correctas **nunca** salen del servidor
- Escritura síncrona en SQLite antes de confirmar al cliente (<10ms)
- Restauración automática de sesiones activas tras reinicio del servidor
- Cola fotográfica con jitter (±1s) para evitar saturación del canal WiFi

---

## Formato CSV

### Padrón de alumnos

```csv
nombre,matricula
Juan García,A001
María López,A002
Carlos Pérez,A003
```

### Banco de preguntas

```csv
examen_titulo,pregunta,opcion_a,opcion_b,opcion_c,opcion_d,correcta
Matemáticas,¿Cuánto es 2+2?,1,3,4,5,C
Matemáticas,¿Cuánto es 5x5?,20,25,30,35,B
Física,Unidad de fuerza,Julio,Newton,Pascal,Watt,B
```

> `correcta` acepta letras (A/B/C/D) o números (0/1/2/3).  
> Múltiples exámenes en el mismo archivo — se agrupan por `examen_titulo`.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                  LAPTOP DEL PROFESOR                     │
│                                                         │
│   Express (:3000)          Socket.io                    │
│   ├── /app/*  → PWA        ├── students (50 conex.)     │
│   ├── /admin/ → Dashboard  └── admin   (1 conex.)       │
│   └── /admin/api → REST                                 │
│                                                         │
│   SQLite WAL  ←→  ExamEngine  StateSaver  PhotoQueue    │
│   database/vortex.db                                    │
└───────────────────────────┬─────────────────────────────┘
                            │ WiFi / Ethernet
                     ┌──────┴──────┐
                     │   ROUTER    │
                     └──────┬──────┘
              ┌─────────────┼─────────────┐
           📱 Alumno    📱 Alumno    📱 Alumno
           PWA /app     PWA /app    PWA /app
```

### Stack

| Capa | Tecnología |
|------|-----------|
| Servidor HTTP | Express 4 + Helmet + Compression |
| Tiempo real | Socket.io 4 (WebSocket puro) |
| Base de datos | better-sqlite3 12 en modo WAL síncrono |
| Autenticación | Bearer Token en memoria (24h TTL) + cookie |
| Frontend admin | Vanilla JS + CSS custom (sin frameworks) |
| Frontend alumno | PWA — Vanilla JS + Service Worker |
| Binario portátil | @yao-pkg/pkg (node22-linux-x64 / node22-win-x64) |

---

## Compilar desde el código fuente

```bash
# Linux
npm run build:linux
# → dist/vortex-linux + dist/better_sqlite3.node

# Windows (cross-compile desde Linux)
npm run build:win
# → dist/vortex-windows.exe
# Requiere better_sqlite3.node compilado en Windows (ver nota abajo)

# Ambos
npm run build:all
```

> **Nota Windows:** El `better_sqlite3.node` incluido en el zip fue compilado para Windows x64.  
> Si compilas el `.exe` en Linux, descarga el prebuilt oficial:  
> `better-sqlite3-v12.x.x-node-v127-win32-x64.tar.gz` desde [releases de better-sqlite3](https://github.com/WiseLibs/better-sqlite3/releases).

---

## Variables de entorno

| Variable | Valor por defecto | Descripción |
|----------|-------------------|-------------|
| `PORT` | `3000` | Puerto del servidor |
| `ADMIN_PASS` | `vortex-admin-2025` | Contraseña inicial (sobreescrita por la DB tras primer cambio) |

---

## Solución de problemas

<details>
<summary><strong>Los alumnos no pueden conectarse</strong></summary>

```bash
# Verificar IP de la laptop
ip addr show      # Linux
ipconfig          # Windows

# Asegurarse de que el alumno usa http:// (no https://)
# URL correcta: http://192.168.1.50:3000/app
```
</details>

<details>
<summary><strong>Firewall de Windows bloquea el servidor</strong></summary>

```powershell
# Ejecutar como administrador
New-NetFirewallRule -DisplayName "VORTEX" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```
</details>

<details>
<summary><strong>La cámara no funciona en iOS / Safari</strong></summary>

iOS requiere HTTPS para acceder a la cámara en red local. VORTEX activa automáticamente el **Modo Token** en este caso — el profesor dicta un código de 4 dígitos para validar la identidad del alumno.
</details>

<details>
<summary><strong>El servidor no arranca: falta better_sqlite3.node</strong></summary>

```
[PKG] FATAL: Falta better_sqlite3.node en: /ruta/al/ejecutable
```

El archivo `better_sqlite3.node` debe estar en la **misma carpeta** que el ejecutable. Descomprime el zip completo — no muevas solo el binario.
</details>

<details>
<summary><strong>Las sesiones no se restauran tras reiniciar</strong></summary>

La carpeta `database/` debe estar en el mismo directorio que el ejecutable. Si cambiaste de ubicación, copia también la carpeta `database/` junto al binario.
</details>

---

## Licencia

VORTEX es un sistema propietario desarrollado para uso educativo.  
© 2025 — Todos los derechos reservados.
