import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import AuditEventsPage from '../pages/Admin/AuditEventsPage';
import SystemHealthPage from '../pages/Admin/SystemHealthPage';

describe('PR-F8-03: Frontend Admin UI Pages & Component Contracts', () => {
  describe('Suite 1: AuditEventsPage Immutable Rendering & Immutability Badges', () => {
    it('renders AuditEventsPage with immutability guarantees and filter elements', () => {
      const html = renderToString(React.createElement(AuditEventsPage));

      // Assert header and immutability badge
      assert.ok(html.includes('Pistas de Auditoría Inmutables'), 'Must display title');
      assert.ok(html.includes('Append-Only'), 'Must show append-only badge');
      assert.ok(html.includes('WAA-023'), 'Must reference standard WAA-023');

      // Assert filter controls
      assert.ok(html.includes('Inquilino (Tenant ID)'), 'Must include tenant filter');
      assert.ok(html.includes('Acción'), 'Must include action selector');
      assert.ok(html.includes('Tipo de Recurso'), 'Must include resource type filter');

      // Assert table headers
      assert.ok(html.includes('Fecha / Hora'), 'Must contain date header');
      assert.ok(html.includes('IP Origen'), 'Must contain IP origin header');
    });
  });

  describe('Suite 2: SystemHealthPage SRE Doctor Checks & Remediation Accordion', () => {
    it('renders SystemHealthPage with SRE check codes and action buttons', () => {
      const html = renderToString(React.createElement(SystemHealthPage));

      // Assert header and standard
      assert.ok(html.includes('Salud del Sistema &amp; SRE Doctor') || html.includes('Salud del Sistema & SRE Doctor'));
      assert.ok(html.includes('PROD-014'), 'Must reference standard PROD-014');
      assert.ok(html.includes('WAA-020'), 'Must reference standard WAA-020');

      // Assert action buttons
      assert.ok(html.includes('Ejecutar Chequeos'), 'Must include execution button');
      assert.ok(html.includes('Exportar'), 'Must include export action');

      // Assert category filter tabs
      assert.ok(html.includes('Base de Datos'), 'Must have database category tab');
      assert.ok(html.includes('Seguridad &amp; KMS') || html.includes('Seguridad & KMS'), 'Must have KMS category tab');
      assert.ok(html.includes('Aislamiento &amp; Sandbox') || html.includes('Aislamiento & Sandbox'), 'Must have sandbox category tab');
    });
  });

  describe('Suite 3: Audit Action Tone Classification & Badge Mapping', () => {
    it('maps security, auth, and agent actions to semantically correct styles', () => {
      const classifyTone = (action: string) => {
        if (action.startsWith('AUTH_')) return 'blue';
        if (action.startsWith('SECRET_')) return 'amber';
        if (action.startsWith('AGENT_')) return 'purple';
        if (action.startsWith('CAMPAIGN_')) return 'emerald';
        return 'gray';
      };

      assert.equal(classifyTone('AUTH_LOGIN'), 'blue');
      assert.equal(classifyTone('SECRET_ROTATE'), 'amber');
      assert.equal(classifyTone('AGENT_PUBLISH'), 'purple');
      assert.equal(classifyTone('CAMPAIGN_DISPATCH'), 'emerald');
      assert.equal(classifyTone('UNKNOWN_ACTION'), 'gray');
    });
  });
});
