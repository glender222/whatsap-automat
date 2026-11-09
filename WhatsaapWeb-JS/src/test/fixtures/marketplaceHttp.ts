import { once } from 'node:events';
import assert from 'node:assert/strict';
import { type TestContext } from 'node:test';
import express from 'express';
import { createMarketplaceRoutes } from '../../routes/marketplaceRoutes';
import { MarketplaceRegistry } from '../../services/marketplace/MarketplaceRegistry';

const jwt = require('jsonwebtoken') as {
  sign(claims: Record<string, unknown>, secret: string, options: { algorithm: 'HS256'; expiresIn: string }): string;
};

export async function marketplaceHttp(t: TestContext, registry?: MarketplaceRegistry) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', createMarketplaceRoutes(registry));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/marketplace`;
  return (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
}

export function accessToken(claims: Record<string, unknown>, secret = process.env.JWT_SECRET!) {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: '5m' });
}

export function jsonPost(body: unknown, token?: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
}
