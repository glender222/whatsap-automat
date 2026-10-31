# Handoff: SESSION_ID / PR_ID

## 1. Identificación y Control
- **ID de Sesión / PR:** <!-- Ej. 00-COORDINADOR / PR-00 -->
- **Rama:** <!-- Ej. docs/pr00-oss-baseline -->
- **Base SHA:** <!-- SHA de origen tomado desde main -->
- **Commit SHA:** <!-- SHA final del commit en este PR -->
- **Estado:** READY_FOR_REVIEW <!-- READY_FOR_REVIEW | BLOCKED | CHANGES_REQUESTED -->

---

## 2. Archivos Modificados
- [ ] <!-- Lista de archivos creados o modificados con ruta completa relativa al repo -->

---

## 3. Implementación Verificada
<!-- Descripción concisa de la solución implementada y alcance cubierto -->

---

## 4. Pruebas Ejecutadas y Resultados Exactos
<!-- Incluir comandos exactos y salida resumida -->
```bash
# Ejemplo:
# Backend: npm run typecheck && npm run build && npm test
# Frontend: npm run build
```

---

## 5. Pruebas No Ejecutadas y Motivo
<!-- Si alguna prueba o validación no se ejecutó, justificar claramente el motivo -->

---

## 6. Hallazgos de Seguridad, Compatibilidad y UX
<!-- Observaciones sobre RLS, JWT, secretos, retrocompatibilidad, etc. -->

---

## 7. Migraciones, Feature Flags y Rollback
<!-- Detalle de migraciones SQL (expand/contract), flags requeridos y procedimiento de reversión -->

---

## 8. Riesgos, Supuestos y Dependencias Pendientes
<!-- Dependencias de otros PRs en curso, riesgos de integración o decisiones técnicas -->

---

## Checklist de Calidad
- [ ] No se incluyen secretos, tokens de Meta, contraseñas ni claves API en commits ni diffs.
- [ ] Se respetó la titularidad exclusiva de archivos según `docs/orchestration/README.md`.
- [ ] Las pruebas automáticas existentes se ejecutaron y están en verde.
- [ ] No se alteró lógica de negocio ajena al alcance del PR.
- [ ] No se realizaron merges ni pushes directos a `main`.
