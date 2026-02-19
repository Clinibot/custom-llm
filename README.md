# Retell Custom LLM — Clinibot

Custom LLM WebSocket server para [Retell AI](https://retellai.com). Usa OpenAI GPT para generar respuestas en streaming.

## Arquitectura

```
Retell Server ←──WebSocket──→ Este Servidor ←──API──→ OpenAI GPT
```

Retell envía transcripciones en tiempo real vía WebSocket. Este servidor procesa los eventos, genera respuestas con OpenAI, y las envía de vuelta en streaming.

## Setup Local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` con tus keys:

```
OPENAI_API_KEY=sk-...
RETELL_API_KEY=key_...
```

### 3. Arrancar el servidor

```bash
npm run dev
```

El servidor arrancará en `http://localhost:8080`.

### 4. Exponer con ngrok (para testing)

```bash
ngrok http 8080
```

Copia la URL de ngrok y crea tu WebSocket URL:

```
wss://xxxx.ngrok-free.app/llm-websocket
```

### 5. Conectar en Retell Dashboard

1. Ve a [Retell Dashboard](https://beta.retellai.com/dashboard)
2. Crea o edita un agente
3. En "Custom LLM", pega tu URL: `wss://tu-dominio/llm-websocket`
4. ¡Prueba la llamada!

## Deploy en producción

Este servidor necesita una plataforma que soporte **WebSockets persistentes**. Opciones recomendadas:

### Railway (recomendado)

```bash
# Instala Railway CLI
npm install -g @railway/cli

# Login y deploy
railway login
railway init
railway up
```

Configura las variables de entorno en el dashboard de Railway.

### Render

1. Conecta el repo en [render.com](https://render.com)
2. Tipo: **Web Service**
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Agrega las variables de entorno

### Fly.io

```bash
fly launch
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set RETELL_API_KEY=key_...
fly deploy
```

> ⚠️ **Nota:** Vercel NO soporta WebSocket servers. No uses Vercel para este proyecto.

## Personalización

### Cambiar el system prompt

Edita el `systemPrompt` en `src/llm-openai-client.ts` para personalizar el comportamiento del agente.

### Cambiar el mensaje de bienvenida

Edita el `content` en el método `BeginMessage` de `src/llm-openai-client.ts`.

### Cambiar el modelo de OpenAI

Modifica el campo `model` en `DraftResponse` (por defecto: `gpt-4o-mini`).

## Estructura del proyecto

```
├── src/
│   ├── server.ts              # Express + WebSocket server
│   ├── types.ts               # Tipos del protocolo Retell
│   └── llm-openai-client.ts   # Cliente OpenAI con streaming
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```
