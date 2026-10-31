# Whatsap-Automat v0.4 — Guía para ejecutar sesiones paralelas en Google Antigravity

## Objetivo

Ejecutar el blueprint v0.4 por PRs aislados, con QA independiente, sin reescritura masiva ni cambios incompatibles. **No pegar el blueprint completo en cada chat**: comprometer la documentación fuente en el repositorio una vez y dar a cada agente un archivo de misión específico.

## Baseline inspeccionado

- Repositorio: `glender222/whatsap-automat`.
- SHA verificado al diseñar el blueprint: `20d16219af37f7203f93d89ec5211f5658d8fcd0`.
- Backend: `WhatsaapWeb-JS` (Node/Express/TypeScript/pg), frontend: `Frontend_py_whatsaapweb` (React/Vite/Jotai).
- Confirmar SHA y estado limpio antes de empezar. Si el repositorio ha avanzado, auditar el diff entre baseline y HEAD y registrar divergencias. NO aplicar cambios ciegamente.

## Paso A — preparar una fuente de verdad (una sola vez)

1. Abrir el repositorio raíz completo como **Project** de Antigravity (no abrir solo una subcarpeta de backend).
2. Copiar manualmente a la raíz del repo la documentación entregada en archivos separados:
   - `WHATSAP_AUTOMAT_BLUEPRINT_V04.md` -> `docs/architecture/BLUEPRINT_v0.4.md`
   - `PR_ROADMAP_V04.md` -> `docs/roadmap/PR_ROADMAP.md`
   - `QA_GATES_V04.md` -> `docs/qa/QA_GATES_AND_CASES.md`
   - `00_GUIA_DE_SESIONES_Y_PREPARACION.md` -> `docs/orchestration/README.md`
3. No reemplazar archivos preexistentes silenciosamente. Si ya existen, comparar versiones y decidir cuál es canónica; evitar duplicados.
4. Commit documental mínimo, en rama propia o `main` únicamente bajo control humano, por ejemplo `docs: add implementation blueprint v0.4`.
5. Verificar que las nuevas sesiones arranquen desde ese commit compartido (mismo SHA). Usar **New Worktree Mode** en cada conversación de implementación.
6. Verificar que cada agente vea `AGENTS.md` raíz y los `AGENTS.md` de frontend/backend. Las instrucciones de esas carpetas son aplicables.

## Paso B — crear el Project / agentes

Documentación oficial de Google Antigravity: https://antigravity.google/docs/projects

- Crear un Project apuntando al checkout Git del repositorio.
- Iniciar conversaciones independientes, una por misión, todas en **New Worktree Mode**. Google documenta que este modo aprovisiona worktrees separados, evitando que agentes editen simultáneamente el mismo working tree.
- Las conversaciones de lectura/revisión pueden utilizar permisos de solo lectura. No otorgar acceso a secretos ni credenciales productivas.
- No compartir `node_modules`, DB de pruebas, puertos localhost ni servicios mutables sin namespacing o bloqueo exclusivo: worktree Git aísla archivos versionados, **no** recursos del sistema.
- Si se utiliza Antigravity IDE clásico y no existe selector Worktree, crear worktrees Git manualmente, cada uno con rama distinta, y abrir cada carpeta como workspace. Comandos opcionales:

```bash
git fetch origin
git status --short
git worktree add -b fix/p0-jwt ../wsa-secure
# Ejecutar desde la carpeta raíz del checkout principal.
# Repetir con un nombre de carpeta y rama diferentes para cada agente.
git worktree list
```

Nunca copiar `.env` con tokens reales a los worktrees. Usar `.env.example` y credenciales mock.

## Sesiones y ownership exclusivo

| Sesión | Prompt | Rama sugerida | Escritura permitida (principal) | No editar |
|---|---|---|---|---|
| 00 Coordinador | `01_SESION_COORDINADOR_PR00.md` | `docs/pr00-oss-baseline` | raíz documentación, `LICENSE`, `.github/workflows`, metadatos package | `src/app.ts`, `src/middleware`, `src/services`, contratos en desarrollo |
| 01 Seguridad | `02_SESION_SEGURIDAD_PR01.md` | `fix/pr01-auth-p0` | auth/middleware/routes backend, nuevos tests de auth | `.github`, `packages/contracts`, `deploy/temporal`, UI |
| 02 Contratos | `03_SESION_CONTRATOS_PR04.md` | `feat/pr04-contracts` | `packages/contracts`, `docs/api`, fixtures contractuales | `src/app.ts`, rutas productivas, Temporal, UI |
| 03 Temporal | `04_SESION_TEMPORAL_PR07.md` | `spike/pr07-temporal` | `deploy/temporal`, `spikes/temporal`, tests de spike | src de API de producción, auth, root package |
| 04 UX/UI | `05_SESION_UXUI_DISENO.md` | `design/uxui-spec-v04` | `docs/ux/` y prototipos aislados | rutas productivas, API backend, contratos publicables |
| 05 QA independiente | `06_SESION_QA_AUDITOR.md` | `audit/qa-v04` | `docs/qa/audits/`, evidencias y fixtures aislados | cambios en código de producto, merges, release |

**Regla:** evitar escribir simultáneamente `AGENTS.md`, README raíz, package-lock raíz o archivos de configuración compartida. Si una misión requiere otro archivo, solicitar al coordinador titularidad exclusiva primero y registrar el cambio.

## Paso C — iniciar en el orden correcto

- Puede arrancar simultáneamente sesiones 00, 01, 02, 03, 04, 05 **después de** publicar el commit documental común.
- La sesión 00 no debe fusionar ramas ajenas automáticamente; prepara gates y baseline.
- La sesión 01 puede implementar PR-01 en worktree propio aunque PR-00 todavía no esté fusionado; antes de merge debe rebasar sobre PR-00 y ejecutar su CI. Si el scope resultara incompatible, detener y aclarar dependencia.
- La sesión 02 define contratos sin forzar cambios en los imports de las apps existentes.
- La sesión 03 valida Temporal sin migrar todavía tráfico real ni acoplarlo al backend.
- Las sesiones 04 y 05 pueden entregar especificaciones de diseño/QA independientemente de los cambios de las otras.
- **NO ejecutar PR-02 Socket.IO como implementación de producción hasta cerrar PR-01. NO activar RLS global hasta auditar consultas legacy y completar tenant-scoped UoW.**

## Paso D — revisión y merge

1. Cada agente entrega rama y commit SHA, lista de archivos, pruebas exactas ejecutadas, salida/evidencia, riesgos, decisiones y estado `READY_FOR_REVIEW` o `BLOCKED`.
2. QA revisa la rama independiente. El autor corrige los hallazgos y vuelve a ejecutar.
3. Coordinador comprueba diff contra baseline, interfaces y ownership; no hay archivos inesperados, secrets ni cambios mass-format.
4. Integrar PR-00 primero. Rebase y merge PR-01 después; PR-04 y PR-07 tras superar sus gates. Diseño/QA documental independiente. No seleccionar merge masivo ni mezclar sesiones.
5. Seguir después PR-02, PR-03, PR-05/06, PR-08 conforme a dependencias del roadmap.

## Formato de handoff obligatorio

```markdown
# Handoff: SESSION_ID / PR_ID
- Rama:
- Base SHA:
- Commit SHA:
- Archivos modificados:
- Implementación verificada:
- Pruebas ejecutadas y resultados exactos:
- Pruebas no ejecutadas y motivo:
- Hallazgos de seguridad, compatibilidad y UX:
- Migraciones/flags/rollback:
- Riesgos y bloqueadores:
- Estado: READY_FOR_REVIEW | BLOCKED | CHANGES_REQUESTED
```

## Reglas innegociables

- No borrar/reemplazar código vigente sin comparar comportamiento y pruebas.
- No inventar que una prueba pasó: incluir comando y resultado real.
- No alterar `main`, no hacer push/merge, y no modificar producción sin revisión/autorización humana.
- No secretos, cuentas Meta reales, cookies, datos de clientes o tokens en prompts/logs.
- Trabajar por PR, diff pequeño, rollback y gates de QA estrictos.
- Toda entrega debe etiquetar HECHO / RIESGO / PROPUESTA / VERIFICACIÓN.
