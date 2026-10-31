# Guía de Contribución — Whatsap-Automat

¡Gracias por tu interés en contribuir a **Whatsap-Automat**! Este documento describe las normas, el flujo de trabajo y los estándares de calidad requeridos para colaborar en el proyecto.

---

## 1. Principios Arquitectónicos y Filosofía

Antes de comenzar a programar, familiarízate con los documentos de arquitectura canónicos en `docs/`:

1. [docs/architecture/BLUEPRINT_v0.4.md](file:///home/glender/.gemini/antigravity/worktrees/whatsap-automat/baseline_reproducible_pr_zero/docs/architecture/BLUEPRINT_v0.4.md): Blueprint de arquitectura v0.4 (ADRs, contratos, modelo de datos, Temporal, omnicanalidad).
2. [docs/roadmap/PR_ROADMAP.md](file:///home/glender/.gemini/antigravity/worktrees/whatsap-automat/baseline_reproducible_pr_zero/docs/roadmap/PR_ROADMAP.md): Plan de implementación incremental por Pull Requests.
3. [docs/qa/QA_GATES_AND_CASES.md](file:///home/glender/.gemini/antigravity/worktrees/whatsap-automat/baseline_reproducible_pr_zero/docs/qa/QA_GATES_AND_CASES.md): Gates de QA, casos de aceptación y pruebas requeridas.
4. [docs/orchestration/README.md](file:///home/glender/.gemini/antigravity/worktrees/whatsap-automat/baseline_reproducible_pr_zero/docs/orchestration/README.md): Guía de orquestación para desarrollo paralelo en Antigravity / Git Worktrees.

### Invariantes Clave:
- **1 PR = 1 frontera clara:** No combines refactorizaciones masivas con cambios de funcionalidad.
- **Fail-closed:** Autenticación estricta en todas las rutas; si falta contexto de tenant o autorización, denegar por defecto.
- **Segregación multi-tenant:** Cada consulta a base de datos debe operar bajo el contexto del tenant con Row-Level Security (RLS).
- **Pruebas deterministas:** Los tests unitarios y de integración deben ejecutarse sin conexión a APIs externas ni claves reales.

---

## 2. Flujo de Desarrollo Paralelo (Worktrees)

En Whatsap-Automat se trabaja mediante **Git Worktrees independientes**, todos originados desde el mismo estado base de `main`:

1. **Aislamiento estricto:** No asumas que los cambios de otros PRs o sesiones en progreso ya existen.
2. **Titularidad exclusiva de archivos:** Modifica únicamente los archivos correspondientes a tu misión asignada.
3. **Mocks e interfaces temporales:** Si requieres contratos o módulos desarrollados en otro PR, utiliza interfaces o stubs documentados según el Blueprint v0.4.
4. **Prohibido merge a `main`:** Ningún agente ni colaborador debe realizar merges, rebases ni pushes automáticos hacia `main`. Toda integración se realiza vía Pull Request revisado y validado en CI.

### Matriz de Titularidad Sugerida:
| Misión / PR | Rama sugerida | Archivos bajo titularidad exclusiva |
| :--- | :--- | :--- |
| **PR-00: Baseline y CI** | `docs/pr00-oss-baseline` | Raíz: docs, `LICENSE`, `.github/`, metadatos de package |
| **PR-01: Auth & JWT P0** | `fix/pr01-auth-p0` | `WhatsaapWeb-JS/src/middleware/jwtAuth.ts`, `app.ts`, routes |
| **PR-02: Socket.IO** | `feat/pr02-socket-rooms` | `WhatsaapWeb-JS/src/sockets/`, `Frontend_py_whatsaapweb/src/utils/socket.ts` |
| **PR-03: DB Audit & RLS** | `feat/pr03-db-rls` | `WhatsaapWeb-JS/src/db/migrations/`, repositorios core |
| **PR-04: Contratos OpenAPI** | `feat/pr04-contracts` | `packages/contracts/`, esquemas y validadores |
| **PR-07: Temporal Spike** | `spike/pr07-temporal` | `deploy/temporal/`, `spikes/temporal/` |

---

## 3. Convenciones de Ramas y Commits

### Nombres de Rama:
Utiliza prefijos claros según el tipo de cambio:
- `feat/pr<id>-<descripcion>`: Nuevas funcionalidades o contratos.
- `fix/pr<id>-<descripcion>`: Correcciones de bugs o parches de seguridad.
- `docs/pr<id>-<descripcion>`: Documentación, especificaciones y guías.
- `test/pr<id>-<descripcion>`: Pruebas unitarias, fixtures o infraestructura de testing.
- `infra/pr<id>-<descripcion>`: CI/CD, configuración de Docker, Temporal o base de datos.
- `audit/pr<id>-<descripcion>`: Informes de auditoría y análisis de calidad.

### Mensajes de Commit (Conventional Commits):
Sigue la especificación de [Conventional Commits](https://www.conventionalcommits.org/):
```text
<tipo>(<alcance opcional>): <descripción concisa en imperativo y minúsculas>

[cuerpo explicativo opcional]

[referencias a issues o PRs]
```
Ejemplos:
- `feat(auth): agregar validacion estricta de company_id en jwt`
- `fix(webhook): rechazar payloads sin firma HMAC valida`
- `docs(ci): documentar ejecucion de suite de pruebas baseline`
- `test(meta): agregar casos de aceptacion MSG-01 para deduplicacion`

---

## 4. Configuración del Entorno de Desarrollo Local

### Requisitos Previos:
- **Node.js:** Versión 20.x LTS recomendada (>= 18.0.0).
- **npm:** Versión >= 10.x.
- **PostgreSQL:** Versión >= 15.

### Paso 1: Clonar y configurar variables de entorno
```bash
git clone https://github.com/glender222/whatsap-automat.git
cd whatsap-automat

# Configurar Frontend
cd Frontend_py_whatsaapweb
cp .env.example .env

# Configurar Backend
cd ../WhatsaapWeb-JS
cp .env.example .env
```

### Paso 2: Instalar dependencias
```bash
# Frontend
cd Frontend_py_whatsaapweb
npm install

# Backend
cd ../WhatsaapWeb-JS
npm install
```

---

## 5. Validaciones y Ejecución de Pruebas

Antes de enviar cualquier cambio, ejecuta las validaciones locales disponibles:

### Validaciones Backend (`WhatsaapWeb-JS`):
```bash
# Verificación de tipos TypeScript
npm run typecheck
npm run typecheck:scripts

# Compilación
npm run build

# Ejecución de suite de pruebas P0 / Unitarias
npm test
# o ejecutar exclusivamente la suite P0:
npm run test:p0
```

### Validaciones Frontend (`Frontend_py_whatsaapweb`):
```bash
# Compilación y verificación de tipos
npm run build

# Análisis estático
npm run lint
```

---

## 6. Definición de Terminado (Definition of Done — DoD)

Cada Pull Request debe cumplir con los siguientes criterios antes de solicitar revisión:
1. **Diff acotado:** Cambios delimitados estrictamente a la responsabilidad del PR.
2. **Cero regresiones:** Todas las pruebas existentes deben continuar en verde.
3. **Pruebas automáticas:** Nuevos endpoints o lógicas deben incluir pruebas unitarias o contract fixtures.
4. **Cero secretos en el historial:** Ninguna credencial, token o variable sensible en commits.
5. **Formato de Handoff completo:** Incluir el resumen obligatorio en la descripción del PR.

### Plantilla de Handoff Obligatoria:
```markdown
# Handoff: SESSION_ID / PR_ID
- **Rama:** <nombre_de_rama>
- **Base SHA:** <sha_de_main_base>
- **Commit SHA:** <sha_del_commit_final>
- **Archivos modificados:** <lista_de_archivos>
- **Implementación verificada:** <resumen_de_lo_implementado>
- **Pruebas ejecutadas y resultados exactos:** <comandos_y_salida>
- **Pruebas no ejecutadas y motivo:** <pruebas_pendientes_si_aplica>
- **Hallazgos de seguridad, compatibilidad y UX:** <hallazgos>
- **Migraciones/flags/rollback:** <plan_de_rollback>
- **Riesgos y bloqueadores:** <riesgos_identificados>
- **Estado:** READY_FOR_REVIEW | BLOCKED | CHANGES_REQUESTED
```
