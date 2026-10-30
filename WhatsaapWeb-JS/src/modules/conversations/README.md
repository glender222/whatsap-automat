# Módulo Conversations — Preparación gradual

> ⚠️ **Estado**: PUENTE / FACADE — `src/core` actual es el conversations legacy/foundation.
> El movimiento real de archivos a `src/modules/conversations/{domain,application,infra}` queda
> para un cambio futuro. No modificar esta estructura hasta que se apruebe la migración física.

## Propósito

Este directorio actúa como **punto de entrada futuro** para el módulo `conversations`.
Por ahora re-exporta todo desde `src/core` mediante aliases seguros, permitiendo que:

1. Nuevo código pueda importar desde `@/modules/conversations` (o el path relativo equivalente).
2. El código legacy que importa desde `dist/core/...` siga funcionando sin cambios.
3. `dist/core` permanezca intacto; `app.js` no se ve afectado.

## Convención

- `facade.ts`: re-exportaciones directas desde `src/core`.
- `index.ts`: barrel público del módulo.
- No se duplica implementación; todo es passthrough.
- No se modifican imports runtime de `app.js` ni controladores legacy.

## Futuro

Cuando se apruebe la migración física:
1. Mover `src/core/domain/*` → `src/modules/conversations/domain/`
2. Mover `src/core/application/*` → `src/modules/conversations/application/`
3. Mover `src/core/infrastructure/*` → `src/modules/conversations/infra/`
4. Actualizar `facade.ts` e `index.ts` para exportar locales en lugar de `src/core`.
5. Actualizar imports internos dentro del módulo.
6. Preservar `dist/core` durante la transición (o crear compat shim).
