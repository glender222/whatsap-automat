# Development Workflow

## Antes De Cambiar Codigo

- Revisa `AGENTS.md` y la rule especifica del area tocada.
- Lee los archivos existentes antes de proponer una estructura nueva.
- Mantente dentro del alcance solicitado; no mezcles refactors grandes con tareas puntuales.
- Revisa `git status` antes de cambios amplios y no reviertas cambios ajenos.

## Validacion

- Ejecuta `npm run build` cuando cambies TypeScript, componentes compartidos, rutas, hooks, servicios o tipos.
- Ejecuta `npm run lint` cuando cambies patrones repetidos, estructura o archivos con logica compleja.
- Si no puedes ejecutar una validacion, deja claro que queda pendiente.

## Documentacion

- Actualiza `docs/DESIGN.md` si cambias criterios visuales, layout principal, navegacion o lenguaje de UI.
- Actualiza docs del modulo si cambias flujos funcionales o contratos de API.
- Mantén `.codex/rules` como reglas estables, no como notas temporales del sprint.

## Commits

- Agrupa cambios relacionados.
- No incluyas `dist`, logs, archivos recuperados o cambios generados si no son parte real del pedido.
- Antes de push, confirma que `main` este sincronizado o resuelve rebase con build exitoso.
