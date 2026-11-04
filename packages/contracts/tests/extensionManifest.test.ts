import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  extensionManifestSchema,
  validateExtensionManifest,
  ExtensionManifest,
} from '../src/extensions';

describe('PR-F7-01: Extension Manifest Contracts', () => {
  test('validates a well-formed tool extension manifest', () => {
    const raw: ExtensionManifest = {
      id: 'acme-search-tool',
      name: 'acme-search-tool',
      version: '1.0.0',
      type: 'tool',
      displayName: 'Acme Search Tool',
      description: 'Searches internal ERP documents',
      author: { name: 'Acme Devs', email: 'dev@acme.com' },
      license: 'MIT',
      entrypoint: 'dist/index.js',
      permissions: ['network:outbound', 'tool:execute'],
      minRuntimeVersion: '^0.4.0',
      metadata: {},
    };

    const res = validateExtensionManifest(raw);
    assert.equal(res.valid, true);
    assert.equal(res.manifest?.type, 'tool');
  });

  test('validates a UI extension manifest with top-level slots', () => {
    const raw = {
      id: 'custom-sidebar',
      name: 'custom-sidebar',
      version: '1.2.0',
      type: 'ui',
      displayName: 'Custom Sidebar UI',
      author: 'UI Team',
      entrypoint: 'dist/index.html',
      slots: ['conversation.sidebar'],
    };

    const res = validateExtensionManifest(raw);
    assert.equal(res.valid, true);
    assert.deepEqual(res.manifest?.slots, ['conversation.sidebar']);
  });

  test('validates a UI extension manifest with ui.slots block', () => {
    const raw = {
      id: 'custom-inbox-sidebar',
      name: 'custom-inbox-sidebar',
      version: '1.0.0',
      type: 'ui',
      entrypoint: 'dist/index.js',
      ui: {
        slots: ['inbox-sidebar'],
        entrypointHtml: './index.html',
      },
    };

    const res = validateExtensionManifest(raw);
    assert.equal(res.valid, true);
  });

  test('rejects UI extension manifest without slots', () => {
    const raw = {
      id: 'custom-sidebar',
      name: 'custom-sidebar',
      version: '1.2.0',
      type: 'ui',
      displayName: 'Custom Sidebar UI',
      author: 'UI Team',
      entrypoint: 'dist/index.html',
    };

    const res = validateExtensionManifest(raw);
    assert.equal(res.valid, false);
    assert.match(res.errors?.[0] || '', /slots/);
  });

  test('rejects invalid SemVer format', () => {
    const raw = {
      id: 'tool-x',
      name: 'tool-x',
      version: 'v1-invalid',
      type: 'tool',
      displayName: 'Tool X',
      author: 'Dev',
      entrypoint: 'index.js',
    };

    const res = validateExtensionManifest(raw);
    assert.equal(res.valid, false);
    assert.match(res.errors?.[0] || '', /SemVer/);
  });
});
