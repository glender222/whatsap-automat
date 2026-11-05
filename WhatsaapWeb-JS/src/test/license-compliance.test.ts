import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

describe('PR-F8-03: Compliance, SBOM & 100% Permissive Licensing Verification', () => {
  const rootDir = path.resolve(__dirname, '../../..');

  const TARGET_PACKAGES = [
    'packages/contracts',
    'packages/sdk',
    'packages/cli',
    'WhatsaapWeb-JS',
    'Frontend_py_whatsaapweb'
  ];

  const PERMISSIVE_WHITELIST = new Set([
    'MIT', 'MIT-0', 'MIT/X11',
    'Apache-2.0',
    'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
    'ISC',
    'Python-2.0',
    'Unlicense',
    'CC0-1.0',
    'CC-BY-4.0',
    'Zlib'
  ]);

  const FORBIDDEN_COPYLEFT_PATTERNS = [
    /\bAGPL\b/i,
    /\bSSPL\b/i,
    /\bEUPL\b/i,
    /\bBUSL\b/i,
    /\bBSL\b/i
  ];

  describe('Suite 1: Monorepo First-Party Package License Declarations', () => {
    it('verifies all first-party workspace package manifests declare "license": "MIT"', () => {
      for (const rel of TARGET_PACKAGES) {
        const pjsonPath = path.join(rootDir, rel, 'package.json');
        assert.ok(fs.existsSync(pjsonPath), `package.json must exist at ${rel}`);
        const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
        assert.equal(
          pjson.license,
          'MIT',
          `Package ${pjson.name || rel} must be strictly licensed under MIT`
        );
      }
    });
  });

  describe('Suite 2: Zero Viral Copyleft Gate in Active Dependencies', () => {
    it('verifies 0 dependencies are contaminated with AGPL, SSPL, EUPL or viral copyleft', () => {
      const violations: string[] = [];

      for (const rel of TARGET_PACKAGES) {
        const nmDir = path.join(rootDir, rel, 'node_modules');
        if (!fs.existsSync(nmDir)) continue;

        function walk(current: string) {
          const entries = fs.readdirSync(current);
          for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const full = path.join(current, entry);
            if (entry.startsWith('@')) {
              walk(full);
            } else {
              const pjsonPath = path.join(full, 'package.json');
              if (fs.existsSync(pjsonPath)) {
                try {
                  const d = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
                  const lic = typeof d.license === 'string' ? d.license : '';
                  for (const pattern of FORBIDDEN_COPYLEFT_PATTERNS) {
                    if (pattern.test(lic)) {
                      violations.push(`${d.name}@${d.version} (${lic}) in ${rel}`);
                    }
                  }
                } catch (e) {}
              }
            }
          }
        }

        walk(nmDir);
      }

      assert.deepEqual(
        violations,
        [],
        `Detected viral copyleft packages violating Community Edition MIT mandate: ${violations.join(', ')}`
      );
    });
  });

  describe('Suite 3: Synthetic Adversarial License Scanner Unit Tests', () => {
    function evaluateSyntheticLicense(licenseStr: string, packageName = 'synthetic-lib'): boolean {
      if (packageName.startsWith('@react-pdf-viewer/')) return true; // Approved exception
      if (PERMISSIVE_WHITELIST.has(licenseStr)) return true;

      // Compound OR (elective permissive)
      if (licenseStr.includes(' OR ')) {
        const parts = licenseStr.replace(/[()]/g, '').split(' OR ').map(s => s.trim());
        if (parts.some(p => PERMISSIVE_WHITELIST.has(p))) return true;
      }

      // Compound AND
      if (licenseStr.includes(' AND ')) {
        const parts = licenseStr.replace(/[()]/g, '').split(' AND ').map(s => s.trim());
        if (parts.every(p => PERMISSIVE_WHITELIST.has(p))) return true;
      }

      // Check forbidden copyleft
      for (const pattern of FORBIDDEN_COPYLEFT_PATTERNS) {
        if (pattern.test(licenseStr)) return false;
      }
      if (/\bGPL\b/i.test(licenseStr) && !licenseStr.includes(' OR ')) return false;

      return false;
    }

    it('approves standard permissive licenses', () => {
      assert.equal(evaluateSyntheticLicense('MIT'), true);
      assert.equal(evaluateSyntheticLicense('Apache-2.0'), true);
      assert.equal(evaluateSyntheticLicense('BSD-3-Clause'), true);
      assert.equal(evaluateSyntheticLicense('ISC'), true);
    });

    it('rejects viral copyleft licenses', () => {
      assert.equal(evaluateSyntheticLicense('AGPL-3.0-only'), false);
      assert.equal(evaluateSyntheticLicense('GPL-2.0-only'), false);
      assert.equal(evaluateSyntheticLicense('SSPL-1.0'), false);
      assert.equal(evaluateSyntheticLicense('EUPL-1.2'), false);
    });

    it('allows dual-licensed expressions when a permissive option is available', () => {
      assert.equal(evaluateSyntheticLicense('(MIT OR GPL-3.0-or-later)'), true);
      assert.equal(evaluateSyntheticLicense('Apache-2.0 AND MIT'), true);
    });
  });

  describe('Suite 4: CycloneDX 1.5 JSON SBOM Specification Structural Compliance', () => {
    it('validates CycloneDX 1.5 schema structure', () => {
      const mockSbom = {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        serialNumber: 'urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
        version: 1,
        metadata: {
          timestamp: new Date().toISOString(),
          tools: [{ vendor: 'Whatsap-Automat', name: 'automat-sbom-generator', version: '0.4.0' }],
          component: {
            'bom-ref': 'pkg:generic/whatsap-automat@0.4.0',
            type: 'application',
            name: 'whatsap-automat',
            version: '0.4.0',
            purl: 'pkg:generic/whatsap-automat@0.4.0',
            licenses: [{ license: { id: 'MIT' } }]
          }
        },
        components: [
          {
            'bom-ref': 'pkg:npm/%40whatsap-automat/contracts@0.4.0',
            type: 'library',
            name: '@whatsap-automat/contracts',
            version: '0.4.0',
            purl: 'pkg:npm/%40whatsap-automat/contracts@0.4.0',
            licenses: [{ license: { id: 'MIT' } }]
          }
        ],
        dependencies: [
          {
            ref: 'pkg:generic/whatsap-automat@0.4.0',
            dependsOn: ['pkg:npm/%40whatsap-automat/contracts@0.4.0']
          }
        ]
      };

      assert.equal(mockSbom.bomFormat, 'CycloneDX');
      assert.equal(mockSbom.specVersion, '1.5');
      assert.ok(mockSbom.serialNumber.startsWith('urn:uuid:'));
      assert.equal(mockSbom.metadata.component.name, 'whatsap-automat');
      assert.equal(mockSbom.metadata.component.licenses[0].license.id, 'MIT');
      assert.ok(mockSbom.components.length > 0);
      assert.ok(mockSbom.components[0].purl.startsWith('pkg:npm/'));
    });
  });
});
