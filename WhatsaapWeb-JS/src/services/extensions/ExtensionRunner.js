'use strict';

const path = require('node:path');

let currentRequestId = null;

// Catch unhandled exceptions in guest process and send structured JSON-RPC error
process.on('uncaughtException', (err) => {
  try {
    if (process.send) {
      process.send({
        jsonrpc: '2.0',
        id: currentRequestId,
        error: {
          code: -32001,
          message: `Uncaught exception in extension guest: ${err && err.message ? err.message : String(err)}`,
          data: { stack: err && err.stack ? err.stack : undefined },
        },
      });
    }
  } catch (_) {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  try {
    if (process.send) {
      process.send({
        jsonrpc: '2.0',
        id: currentRequestId,
        error: {
          code: -32001,
          message: `Unhandled rejection in extension guest: ${reason && reason.message ? reason.message : String(reason)}`,
          data: { stack: reason && reason.stack ? reason.stack : undefined },
        },
      });
    }
  } catch (_) {}
  process.exit(1);
});

// Listen for invocation requests from ExtensionHost via Node IPC
process.on('message', async (message) => {
  if (!message || message.jsonrpc !== '2.0' || !message.id) {
    if (process.send) {
      process.send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid JSON-RPC request envelope',
        },
      });
    }
    process.exit(1);
  }

  currentRequestId = message.id;

  if (message.method !== 'execute') {
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `Method '${message.method}' not supported by ExtensionRunner`,
      },
    });
    process.exit(1);
  }

  const { extensionPath, method = 'execute', params = {} } = message.params || {};

  if (!extensionPath) {
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32602,
        message: 'Missing extensionPath in invocation parameters',
      },
    });
    process.exit(1);
  }

  let mod;
  try {
    const resolvedPath = path.isAbsolute(extensionPath)
      ? extensionPath
      : path.resolve(process.cwd(), extensionPath);

    // Dynamic resolution: supports CommonJS and ESM
    try {
      mod = require(resolvedPath);
    } catch (requireErr) {
      if (requireErr && requireErr.code === 'ERR_REQUIRE_ESM') {
        const esmMod = await import(resolvedPath);
        mod = esmMod.default || esmMod;
      } else {
        throw requireErr;
      }
    }
  } catch (err) {
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: `Failed to load extension module: ${err && err.message ? err.message : String(err)}`,
        data: { stack: err && err.stack ? err.stack : undefined },
      },
    });
    process.exit(1);
  }

  // Find execution handler
  let handler;
  if (typeof mod === 'function') {
    handler = mod;
  } else if (mod && typeof mod[method] === 'function') {
    handler = mod[method];
  } else if (mod && typeof mod.run === 'function') {
    handler = mod.run;
  } else if (mod && typeof mod.execute === 'function') {
    handler = mod.execute;
  } else if (mod && mod.default && typeof mod.default === 'function') {
    handler = mod.default;
  }

  if (typeof handler !== 'function') {
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `Handler function '${method}' not found in extension module`,
      },
    });
    process.exit(1);
  }

  try {
    const result = await handler(params);
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      result: result !== undefined ? result : null,
    });
    process.exit(0);
  } catch (execErr) {
    process.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32000,
        message: execErr && execErr.message ? execErr.message : String(execErr),
        data: { stack: execErr && execErr.stack ? execErr.stack : undefined },
      },
    });
    process.exit(1);
  }
});
