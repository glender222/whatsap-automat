# Socket.IO Rules

Estas reglas aplican a eventos en tiempo real, rooms y compatibilidad con frontend.

## Responsabilidad

- Socket.IO transporta eventos; no debe contener reglas de negocio principales.
- La logica debe vivir en services, core, modules o adaptadores.
- Mantener `socketHandler` como punto de conexion y coordinacion, no como service gigante.

## Eventos

- Mantener nombres de eventos estables si el frontend los consume.
- Documentar o actualizar docs cuando se agregue, renombre o cambie payload de un evento.
- Evitar payloads enormes; enviar datos necesarios y permitir que el frontend consulte detalle si aplica.
- No enviar secretos, tokens, headers ni informacion interna sensible por sockets.

## Rooms

- Usar rooms para aislar conversaciones, empresas o usuarios segun corresponda.
- Validar permisos antes de unir a rooms sensibles.
- No confiar en `chatId` o `companyId` enviado por cliente sin validacion cuando haya datos privados.

## Mensajes Y Conversaciones

- Los mensajes entrantes deben formatearse a contrato interno antes de emitirse.
- Preservar compatibilidad con eventos usados por bandeja de chats y panel de mensajes.
- Evitar duplicados con idempotencia cuando un webhook o provider pueda reenviar eventos.

## Frontend

- Si se cambia un evento, revisar usos en `C:\whatsap\Frontend_py_whatsaapweb`.
- Mantener reconexion tolerante y estados claros: conectado, desconectado, cargando, error.
- No romper flujos legacy si el frontend aun depende de ellos.

## Validacion

- Para cambios en sockets, probar flujo manual si es viable: conectar, unirse a room, recibir evento y desconectar.
- Ejecutar `npm run typecheck` cuando cambien tipos o imports.
