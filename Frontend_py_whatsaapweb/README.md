# Frontend de la plataforma multiagente para WhatsApp

Interfaz web para operar conversaciones, agentes de IA, catálogo e inventario, pedidos y escalamiento humano. Está construida con React, TypeScript y Vite.

El navegador se comunica exclusivamente con el backend del proyecto:

```text
Frontend (REST + Socket.IO) -> Backend propio -> WhatsApp Cloud API / agentes / base de datos
```

La verificación del webhook, el acceso a Meta y los proveedores de IA pertenecen al backend. No se deben guardar tokens de Meta, secretos de aplicaciones ni claves de IA en este repositorio o en variables `VITE_*`.

## Configuración

Requisitos: Node.js y npm, además del backend configurado y en ejecución.

Desde la raíz de este proyecto:

```bash
npm install
cp .env.example .env
```

Configura la URL pública o local del backend en `.env`:

```dotenv
VITE_API_URL=http://localhost:3000/api
```

`VITE_API_URL` debe incluir el prefijo `/api`. Si el backend se publica mediante Cloudflare Tunnel, usa la URL HTTPS entregada por el túnel y conserva ese prefijo:

```dotenv
VITE_API_URL=https://<subdominio>.trycloudflare.com/api
```

Vite incorpora las variables `VITE_*` al frontend, por lo que son públicas. Después de cambiar `.env`, reinicia el servidor de desarrollo o genera un build nuevo.

## Ejecución

```bash
npm run dev
```

Vite muestra en la terminal la URL local del frontend. El backend debe permitir ese origen en su configuración CORS.

## Scripts

- `npm run dev`: inicia Vite en modo desarrollo.
- `npm run build`: ejecuta el typecheck y genera el build de producción.
- `npm run lint`: analiza el código con ESLint.
- `npm run preview`: sirve localmente el build generado.

## Integración con el backend

- Las solicitudes REST usan `VITE_API_URL` mediante `src/shared/axios/http.ts`.
- Socket.IO deriva automáticamente el origen del backend desde la misma variable en `src/utils/socket.ts`, eliminando el sufijo `/api`.
- La autenticación de las solicitudes se centraliza en el cliente HTTP.
- La configuración de Meta Developers, el webhook de WhatsApp y sus credenciales se administran en el backend.

Para validar un clon limpio después de configurar `.env`:

```bash
npm run build
```
