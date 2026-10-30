# Development Workflow Rules

Estas reglas buscan que el desarrollo sea agil, pero verificable y ordenado.

## Forma De Trabajo

- Entender primero el objetivo del cambio y el area afectada.
- Leer los archivos cercanos antes de editar.
- Hacer cambios pequenos, enfocados y faciles de revisar.
- Evitar refactors grandes si el usuario pidio una correccion puntual.
- No mezclar tareas no relacionadas en el mismo cambio.
- Priorizar que el backend siga levantando, compilando y manteniendo contratos estables.

## Antes De Editar

Para cambios de backend, revisar segun aplique:

- `package.json` para scripts disponibles.
- `src/app.ts` para rutas, middleware y composicion.
- La ruta afectada en `src/routes`.
- El service o modulo afectado en `src/services`, `src/core` o `src/modules`.
- Migraciones en `src/db/migrations` si el cambio toca persistencia.
- `README.md` o `docs/` si el cambio toca flujos documentados.

## Durante El Cambio

- Preferir TypeScript para codigo nuevo.
- Mantener controladores y rutas delgados.
- Poner reglas de negocio en services, casos de uso o modulos.
- Mantener nombres claros y consistentes con el dominio: company, conversation, message, contact, tag, agent, whatsapp.
- Reusar helpers, mappers, repositorios y puertos existentes antes de crear nuevas abstracciones.
- Si una decision queda importante para el futuro, documentarla en `docs/current-state.md` o en el archivo de docs correspondiente.

## Validacion

Ejecutar validaciones proporcionales al cambio:

- Cambios TypeScript: `npm run typecheck`.
- Cambios de build o imports: `npm run build`.
- Cambios de base de datos: `npm run db:status` y, si aplica, `npm run db:migrate`.
- Cambios de webhook o Meta: probar endpoint local o documentar la prueba manual requerida.
- Cambios de contrato con frontend: revisar usos en `C:\whatsap\Frontend_py_whatsaapweb`.

Si una validacion no puede ejecutarse, indicarlo al entregar.

## Memoria Del Proyecto

Actualizar documentacion cuando el cambio modifique:

- arquitectura;
- contratos de API;
- eventos Socket.IO;
- migraciones o modelo de datos;
- flujo Meta Cloud API;
- decisiones tecnicas relevantes;
- estado actual del sprint.

La documentacion de trabajo debe vivir en `docs/`. Las reglas para Codex deben vivir en `.codex/rules/`.

## Entrega De Cambios

Al finalizar, responder con:

- archivos importantes modificados;
- validaciones ejecutadas;
- validaciones pendientes si existen;
- riesgos o notas operativas, especialmente si hay cambios en `.env`, tokens, webhooks, migraciones o frontend.

## No Hacer

- No introducir dependencias nuevas sin necesidad clara.
- No cambiar contratos publicos sin revisar impacto.
- No editar secretos reales.
- No imprimir tokens, claves o credenciales.
- No reescribir migraciones antiguas salvo instruccion explicita.
- No cambiar frontend desde el backend salvo que el usuario lo pida o el contrato lo exija.
