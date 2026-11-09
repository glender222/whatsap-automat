# Whatsap-Automat

[![CI](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml/badge.svg)](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

Plataforma de código abierto para automatización omnicanal y orquestación duradera de agentes de Inteligencia Artificial para empresas y desarrolladores.

---

## 1. Visión y Objetivos

Whatsap-Automat está diseñado bajo un paradigma **automation-first**:
- **Omnicanalidad nativa:** Soporte para WhatsApp (Meta Cloud API oficial), Telegram, Instagram y Messenger, con identidades estrictamente desacopladas por canal.
- **Orquestación duradera:** Transición hacia flujos de trabajo de ejecución duradera con Temporal OSS, garantizando recuperación ante caídas, idempotencia transaccional y timers fiables.
- **Arquitectura Multi-tenant Segura:** Aislamiento de datos empresariales mediante PostgreSQL Row-Level Security (RLS) forzado y políticas de autenticación JWT *fail-closed*.
- **Harness de Agentes IA:** Agentes multi-modelo (OpenAI, OpenCode Zen, BYOK y modelos locales) con grafos versionados, presupuestos estrictos y Policy Engine con aprobación humana (*human-in-the-loop*).
- **Self-hosted y Cloud:** Capacidad de auto-alojamiento completo sin dependencias forzosas de servicios privativos.

---

## 2. Estructura del Monorepo

```text
whatsap-automat/
├── docs/                               # Documentación arquitectónica canónica v0.4
│   ├── architecture/BLUEPRINT_v0.4.md  # Blueprint arquitectónico maestro
│   ├── roadmap/PR_ROADMAP.md           # Plan de implementación incremental por PRs
│   ├── qa/QA_GATES_AND_CASES.md        # Gates de aceptación y matriz de pruebas
│   └── orchestration/README.md         # Guía de orquestación para desarrollo paralelo
├── Frontend_py_whatsaapweb/            # Frontend Web (React 18, Vite, TypeScript, Tailwind)
├── WhatsaapWeb-JS/                     # Backend API (Node.js, Express, TypeScript, PostgreSQL)
├── .github/                            # Workflows de CI/CD, Dependabot y plantillas
├── CONTRIBUTING.md                     # Procedimientos y reglas de contribución
├── SECURITY.md                         # Política de divulgación responsable de vulnerabilidades
├── CODE_OF_CONDUCT.md                  # Código de conducta de la comunidad
└── LICENSE                             # Licencia MIT
```

---

## 3. Estado de la rama de integración

`integration/v0.4-consolidated` contiene el trabajo de las fases F0–F9. La preparación para una release se valida por recorridos y por commit. El [plan de validación](docs/roadmap/PRODUCT_VALIDATION_PLAN.md) define los controles de instalación, aislamiento, UX, proveedores y distribución. El [roadmap v1.0](docs/architecture/ROADMAP_V1.0.md) conserva el alcance de producto.

El [portal de documentación](docs-site/README.md) se puede compilar localmente y ofrece la guía de inicio, la licencia y los contratos OpenAPI como descargas.

---

## 4. Requisitos Previos

- **Node.js:** Versión 22.x para el entorno completo.
- **npm:** Versión 10.x o superior.
- **PostgreSQL:** Versión 16 para desarrollo y pruebas de integración.
- **Git:** Versión 2.30+ con soporte para `git worktree`.

---

## 5. Inicio Rápido (Desarrollo Local)

### 1. Clonar el repositorio
```bash
git clone --branch integration/v0.4-consolidated https://github.com/glender222/whatsap-automat.git
cd whatsap-automat
npm --prefix packages/contracts ci
npm --prefix packages/contracts run build
```

### 2. Configurar Frontend
```bash
cd Frontend_py_whatsaapweb
cp .env.example .env
npm ci
npm run dev
```
La aplicación web estará disponible en `http://localhost:5173`.

### 3. Configurar Backend
```bash
cd ../WhatsaapWeb-JS
cp .env.example .env
# Edita .env con las credenciales de tu base de datos local y puertos
npm ci
npm run db:migrate
npm run typecheck
npm run build
npm run dev
```
La API estará disponible en `http://localhost:3000`.

---

## 6. Verificación y Suite de Pruebas

Para garantizar la reproducibilidad y estabilidad del baseline, ejecuta las pruebas locales:

### Backend:
```bash
cd WhatsaapWeb-JS

# Validación de tipos estáticos
npm run typecheck
npm run typecheck:scripts

# Compilación TypeScript
npm run build

# Ejecución de suite de pruebas P0 y regresión
npm test
```

### Frontend:
```bash
cd Frontend_py_whatsaapweb

# Compilación y empaquetado de producción
npm run build

# Análisis de calidad y linter
npm run lint
```

---

## 7. Documentación de Referencia

Para comprender a fondo el diseño técnico, consulta los documentos de especificación:

- [Blueprint Arquitectónico v0.4](docs/architecture/BLUEPRINT_v0.4.md)
- [Plan de PRs y Roadmap](docs/roadmap/PR_ROADMAP.md)
- [Criterios de QA y Casos de Aceptación](docs/qa/QA_GATES_AND_CASES.md)
- [Guía de Orquestación y Sesiones Paralelas](docs/orchestration/README.md)

---

## 8. Contribuciones y Seguridad

- Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para conocer las normas de contribución, convenciones de commit y uso de worktrees.
- Consulta [SECURITY.md](SECURITY.md) para conocer nuestra política de seguridad y cómo reportar vulnerabilidades de forma privada.
- Consulta [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) para las pautas de convivencia comunitaria.

---

## 9. Licencia

Este proyecto está licenciado bajo los términos de la **Licencia MIT**. Consulta el archivo [LICENSE](LICENSE) para más detalles.
