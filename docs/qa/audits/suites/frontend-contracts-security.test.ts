import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = path.resolve(__dirname, '../../../../');
const frontendDir = path.join(rootDir, 'Frontend_py_whatsaapweb');

describe('QA Security Audit: Frontend Regressions, Contratos y Seguridad en Cliente', () => {

  describe('1. Higiene Arquitectónica y Dependencias Extrañas', () => {
    test('HALLAZGO CRÍTICO QA: Frontend package.json contiene librerías exclusivas de backend (express, cors, whatsapp-web.js)', () => {
      const packageJsonPath = path.join(frontendDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      const backendOnlyPackages = ['express', 'cors', 'body-parser', 'whatsapp-web.js'];
      const foundInDependencies = backendOnlyPackages.filter(p => pkg.dependencies?.[p]);

      assert.equal(
        foundInDependencies.length,
        4,
        `VULNERABILIDAD/DEUDA TÉCNICA: El frontend tiene acopladas dependencias de servidor: ${foundInDependencies.join(', ')}`
      );
    });

    test('Verificación de Seguridad: Frontend NO realiza llamadas directas a Meta Graph API (graph.facebook.com)', () => {
      const srcDir = path.join(frontendDir, 'src');
      let directMetaCallFound = false;

      function scanDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (/graph\.facebook\.com/i.test(content)) {
              directMetaCallFound = true;
            }
          }
        }
      }

      scanDir(srcDir);
      assert.equal(
        directMetaCallFound,
        false,
        'CUMPLE CONTRATO: No existen llamadas directas a Facebook Graph API desde el frontend'
      );
    });
  });

  describe('2. Auditoría del Interceptor HTTP (http.ts)', () => {
    test('http.ts inyecta Bearer token y maneja cola de concurrencia en refresco de 401', () => {
      const httpFile = path.join(frontendDir, 'src/shared/axios/http.ts');
      const content = fs.readFileSync(httpFile, 'utf8');

      assert.ok(
        content.includes("['Authorization'] = `Bearer ${token}`"),
        'Debe inyectar token en header Authorization'
      );

      assert.ok(
        content.includes('isRefreshing'),
        'Debe implementar flag de control de refresco activo'
      );

      assert.ok(
        content.includes('subscribeTokenRefresh'),
        'Debe encolar suscriptores concurrentes para evitar múltiples llamadas refresh paralelas'
      );
    });
  });

  describe('3. Auditoría del Cliente Socket (socket.ts y useSocketSimple.tsx)', () => {
    test('SocketService envía token en handshake auth pero expone joinRoom sin scope de tenant', () => {
      const socketFile = path.join(frontendDir, 'src/utils/socket.ts');
      const content = fs.readFileSync(socketFile, 'utf8');

      assert.ok(
        content.includes('auth: {'),
        'Debe enviar auth object en la inicialización del socket'
      );
      assert.ok(
        content.includes('token: token || \'\''),
        'Debe enviar el token de autenticación en el handshake'
      );

      // Verificamos vulnerabilidad de room sin namespace de empresa
      assert.ok(
        content.includes("this.socket.emit('join', chatId);"),
        'HALLAZGO SEC-02: Emite join pasando solo chatId plano, sin prefijo companyId'
      );
    });

    test('HALLAZGO CRÍTICO QA: Presencia de archivos corruptos binarios en raíz del frontend que rompen eslint', () => {
      const binaryFiles = [
        path.join(frontendDir, 'recovered_SettingsModal.tsx'),
        path.join(frontendDir, 'recovered_useSocketSimple.tsx')
      ];

      for (const file of binaryFiles) {
        assert.ok(fs.existsSync(file), `El archivo ${path.basename(file)} existe`);
        const buffer = fs.readFileSync(file);
        // Comprobamos si tiene bytes nulos (indicador de archivo binario corrupto)
        const isBinary = buffer.includes(0);
        assert.equal(
          isBinary,
          true,
          `EVIDENCIA DE ERROR EN LINT: ${path.basename(file)} es un archivo binario corrupto que rompe el linter con 'File appears to be binary'`
        );
      }
    });
  });
});
