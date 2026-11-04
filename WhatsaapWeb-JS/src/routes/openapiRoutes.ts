import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

export interface OpenApiRoutesOptions {
  specDir?: string;
}

export function resolveSpecFilePath(filename: string, customDir?: string): string {
  const candidateDirs = [
    customDir,
    path.resolve(__dirname, '../../../docs/api'),
    path.resolve(process.cwd(), 'docs/api'),
    path.resolve(process.cwd(), '../docs/api'),
    path.resolve(__dirname, '../../../../docs/api'),
  ].filter(Boolean) as string[];

  for (const dir of candidateDirs) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  return path.resolve(process.cwd(), 'docs/api', filename);
}

export function createOpenApiRoutes(options: OpenApiRoutesOptions = {}): Router {
  const router = Router();

  let cachedJson: string | null = null;
  let cachedYaml: string | null = null;
  let jsonEtag: string | null = null;
  let yamlEtag: string | null = null;

  function loadSpecs(): void {
    const jsonPath = resolveSpecFilePath('openapi.v1.json', options.specDir);
    const yamlPath = resolveSpecFilePath('openapi.v1.yaml', options.specDir);

    if (fs.existsSync(jsonPath)) {
      cachedJson = fs.readFileSync(jsonPath, 'utf8');
      jsonEtag = `W/"${Buffer.byteLength(cachedJson).toString(16)}-${fs.statSync(jsonPath).mtimeMs}"`;
    }

    if (fs.existsSync(yamlPath)) {
      cachedYaml = fs.readFileSync(yamlPath, 'utf8');
      yamlEtag = `W/"${Buffer.byteLength(cachedYaml).toString(16)}-${fs.statSync(yamlPath).mtimeMs}"`;
    }
  }

  // Initial load
  loadSpecs();

  // GET /api/v1/openapi.json
  router.get('/openapi.json', (req: Request, res: Response) => {
    if (!cachedJson) {
      loadSpecs();
    }

    if (!cachedJson) {
      return res.status(404).json({
        type: 'https://api.whatsap-automat.internal/errors/not-found',
        title: 'OpenAPI Specification Not Found',
        status: 404,
        detail: 'The OpenAPI JSON specification could not be located on this server.',
        instance: req.originalUrl,
      });
    }

    if (jsonEtag && req.headers['if-none-match'] === jsonEtag) {
      return res.status(304).end();
    }

    if (jsonEtag) {
      res.setHeader('ETag', jsonEtag);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(cachedJson);
  });

  // GET /api/v1/openapi.yaml
  router.get('/openapi.yaml', (req: Request, res: Response) => {
    if (!cachedYaml) {
      loadSpecs();
    }

    if (!cachedYaml) {
      return res.status(404).json({
        type: 'https://api.whatsap-automat.internal/errors/not-found',
        title: 'OpenAPI Specification Not Found',
        status: 404,
        detail: 'The OpenAPI YAML specification could not be located on this server.',
        instance: req.originalUrl,
      });
    }

    if (yamlEtag && req.headers['if-none-match'] === yamlEtag) {
      return res.status(304).end();
    }

    if (yamlEtag) {
      res.setHeader('ETag', yamlEtag);
    }
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(cachedYaml);
  });

  // GET /api/v1/openapi (Content Negotiation fallback)
  router.get('/openapi', (req: Request, res: Response) => {
    const accepts = req.headers.accept || '';
    if (accepts.includes('application/yaml') || accepts.includes('text/yaml')) {
      return res.redirect(307, `${req.baseUrl}/openapi.yaml`);
    }
    return res.redirect(307, `${req.baseUrl}/openapi.json`);
  });

  // GET /api/v1/docs (Interactive OpenAPI 3.1 documentation viewer)
  router.get('/docs', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html>
<html>
  <head>
    <title>Whatsap-Automat API v1 Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/@scalar/api-reference@1.25.105/dist/browser/standalone.css" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="./openapi.json"
      src="https://unpkg.com/@scalar/api-reference@1.25.105/dist/browser/standalone.js"
    ></script>
  </body>
</html>`);
  });

  return router;
}

export default createOpenApiRoutes;
