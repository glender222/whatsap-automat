# Whatsap Automat (Monorepo)

Proyecto general de automatización de WhatsApp, compuesto por frontend y backend.

## Estructura del Proyecto

- **[Frontend_py_whatsaapweb](./Frontend_py_whatsaapweb)**: Interfaz de usuario construida con React, TypeScript, Tailwind CSS y Vite.
- **[WhatsaapWeb-JS](./WhatsaapWeb-JS)**: Backend y orquestador de mensajería construido con Node.js, Express, TypeScript, PostgreSQL y servicios de IA.

## Requisitos Previos

- Node.js >= 18
- PostgreSQL
- Variables de entorno configuradas a partir de los archivos `.env.example` en cada subcarpeta.

## Configuración Rápida

### Frontend
```bash
cd Frontend_py_whatsaapweb
cp .env.example .env
npm install
npm run dev
```

### Backend
```bash
cd WhatsaapWeb-JS
cp .env.example .env
npm install
npm run dev
```
