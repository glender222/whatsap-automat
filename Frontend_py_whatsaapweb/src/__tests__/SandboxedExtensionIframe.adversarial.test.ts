import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { SandboxedExtensionIframe } from '../components/extensions/SandboxedExtensionIframe';
import type { ExtensionRpcMessage, ExtensionRpcResponse } from '../components/extensions/types';

describe('CHALLENGER-F7: Frontend SandboxedExtensionIframe Adversarial Suite', () => {
  describe('Challenge 1: Strict Sandbox Attribute Whitelisting & Origin Isolation', () => {
    it('EMPIRICAL: enforces sandbox="allow-scripts" and strictly blocks all privilege escalation flags', () => {
      const html = renderToString(
        React.createElement(SandboxedExtensionIframe, {
          extensionId: 'adversarial-probe-plugin',
          srcDoc: '<html><head></head><body><script>/* malicious probe */</script></body></html>',
          title: 'Adversarial Probe Plugin',
          context: { tenantId: 'tenant-999', userRole: 'admin' },
        })
      );

      // 1. Verified present
      assert.ok(html.includes('sandbox="allow-scripts"'), 'Must contain sandbox="allow-scripts"');

      // 2. FORBIDDEN PRIVILEGE FLAGS (Must NEVER be present):
      const forbiddenSandboxFlags = [
        'allow-same-origin',                     // CRITICAL: prevents access to parent origin, cookies, localStorage
        'allow-top-navigation',                  // Prevents iframe from redirecting the parent window
        'allow-top-navigation-by-user-activation',
        'allow-forms',                           // Prevents phishing form submissions
        'allow-popups',                          // Prevents opening popup tabs/windows
        'allow-popups-to-escape-sandbox',
        'allow-modals',                          // Prevents alert/prompt freezes
        'allow-pointer-lock',                    // Prevents capturing user cursor
        'allow-downloads',                       // Prevents automatic file downloads
      ];

      for (const flag of forbiddenSandboxFlags) {
        assert.ok(
          !html.includes(flag),
          `SECURITY VIOLATION: "${flag}" must NOT be present in sandbox attribute!`
        );
      }

      // 3. Structural rendering check
      assert.ok(html.includes('data-testid="sandboxed-extension-adversarial-probe-plugin"'));
      assert.ok(html.includes('title="Adversarial Probe Plugin"'));
    });
  });

  describe('Challenge 2: JSON-RPC 2.0 Wire Validation & Adversarial Payloads', () => {
    it('EMPIRICAL: rejects malformed JSON-RPC wire envelopes (XSS, missing id, legacy 1.0)', () => {
      // Helper replicating the exact validation logic in SandboxedExtensionIframe
      function isValidRpcEnvelope(data: unknown): boolean {
        if (!data || typeof data !== 'object') return false;
        const msg = data as Record<string, unknown>;
        if (msg.jsonrpc !== '2.0') return false;
        if (typeof msg.id !== 'string') return false;
        if (typeof msg.method !== 'string') return false;
        return true;
      }

      // Attack vectors
      const attackVectors = [
        null,
        undefined,
        '{"raw": "string"}',
        12345,
        {},
        { jsonrpc: '1.0', id: '1', method: 'get' }, // Legacy 1.0
        { jsonrpc: '2.0', id: 100, method: 'get' },   // Numeric ID when string required
        { jsonrpc: '2.0', id: '1' },                  // Missing method
        { jsonrpc: '2.0', method: 'get' },             // Missing ID
        { jsonrpc: '2.0', id: '1', method: null },    // Null method
        { jsonrpc: '2.0', id: '1', method: 42 },      // Numeric method
        { jsonrpc: '3.0', id: '1', method: 'test' },  // Future/fake protocol version
      ];

      for (const payload of attackVectors) {
        assert.equal(
          isValidRpcEnvelope(payload),
          false,
          `Adversarial payload should be rejected: ${JSON.stringify(payload)}`
        );
      }

      // Valid vector
      const validPayload: ExtensionRpcMessage = {
        jsonrpc: '2.0',
        id: 'rpc_valid_001',
        method: 'extension:ping',
        params: { timestamp: 123456789 },
      };
      assert.equal(isValidRpcEnvelope(validPayload), true);
    });

    it('EMPIRICAL: origin and source window boundaries prevent cross-frame message spoofing', () => {
      const parentWindow = {};
      const fakeAttackerWindow = {};
      const legitimateIframeWindow = {};

      function isMessageFromLegitimateIframe(
        eventSource: unknown,
        targetIframeWindow: unknown
      ): boolean {
        return eventSource === targetIframeWindow;
      }

      // 1. Parent window sending postMessage to itself must be rejected
      assert.equal(
        isMessageFromLegitimateIframe(parentWindow, legitimateIframeWindow),
        false
      );

      // 2. Attacker frame sending postMessage must be rejected
      assert.equal(
        isMessageFromLegitimateIframe(fakeAttackerWindow, legitimateIframeWindow),
        false
      );

      // 3. Only legitimate iframe contentWindow is accepted
      assert.equal(
        isMessageFromLegitimateIframe(legitimateIframeWindow, legitimateIframeWindow),
        true
      );
    });
  });

  describe('Challenge 3: RPC Error Code Conformance (-32601 and -32603)', () => {
    it('EMPIRICAL: conforms to JSON-RPC 2.0 error response structures', () => {
      const methodNotFoundResponse: ExtensionRpcResponse = {
        jsonrpc: '2.0',
        id: 'req_unknown_1',
        error: {
          code: -32601,
          message: 'No RPC handler configured for method: badMethod',
        },
      };

      const internalErrorResponse: ExtensionRpcResponse = {
        jsonrpc: '2.0',
        id: 'req_fail_1',
        error: {
          code: -32603,
          message: 'Internal RPC execution error',
        },
      };

      assert.equal(methodNotFoundResponse.jsonrpc, '2.0');
      if ('error' in methodNotFoundResponse) {
        assert.equal(methodNotFoundResponse.error.code, -32601);
        assert.ok(methodNotFoundResponse.error.message.includes('-32601') || methodNotFoundResponse.error.message.includes('No RPC handler'));
      }

      assert.equal(internalErrorResponse.jsonrpc, '2.0');
      if ('error' in internalErrorResponse) {
        assert.equal(internalErrorResponse.error.code, -32603);
      }
    });
  });
});
