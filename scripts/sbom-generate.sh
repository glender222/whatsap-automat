#!/usr/bin/env bash
# ==============================================================================
# Whatsap-Automat: CycloneDX 1.5 JSON SBOM Generator
# Standard: WAA-024, PROD-011, CycloneDX v1.5 Specification
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_FILE="${ROOT_DIR}/sbom.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./scripts/sbom-generate.sh [--output <path>]"
      exit 0
      ;;
    *)
      OUTPUT_FILE="$1"
      shift
      ;;
  esac
done

mkdir -p "$(dirname "$OUTPUT_FILE")"

node - << 'EOF' "$ROOT_DIR" "$OUTPUT_FILE"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [,, rootDir, outputFile] = process.argv;

const WORKSPACE_PACKAGES = [
  { dir: 'packages/contracts', name: '@whatsap-automat/contracts', type: 'library' },
  { dir: 'packages/sdk', name: '@whatsap-automat/sdk', type: 'library' },
  { dir: 'packages/cli', name: '@whatsap-automat/cli', type: 'application' },
  { dir: 'WhatsaapWeb-JS', name: 'whatsap-automat-backend', type: 'application' },
  { dir: 'Frontend_py_whatsaapweb', name: 'whatsap-automat-frontend', type: 'application' }
];

const serialNumber = `urn:uuid:${crypto.randomUUID()}`;
const timestamp = new Date().toISOString();

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber,
  version: 1,
  metadata: {
    timestamp,
    tools: [
      {
        vendor: "Whatsap-Automat",
        name: "automat-sbom-generator",
        version: "0.4.0"
      }
    ],
    component: {
      "bom-ref": "pkg:generic/whatsap-automat@0.4.0",
      type: "application",
      name: "whatsap-automat",
      version: "0.4.0",
      description: "Multi-tenant WhatsApp & Omnichannel AI Orchestration Engine",
      licenses: [
        {
          license: {
            id: "MIT"
          }
        }
      ],
      purl: "pkg:generic/whatsap-automat@0.4.0"
    }
  },
  components: [],
  dependencies: []
};

const registeredComponents = new Map();
const rootDependsOn = [];

// 1. Register First-Party Monorepo Packages
for (const wp of WORKSPACE_PACKAGES) {
  const pjsonPath = path.join(rootDir, wp.dir, 'package.json');
  if (!fs.existsSync(pjsonPath)) continue;

  const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
  const version = pjson.version || '0.4.0';
  const encodedName = wp.name.replace('@', '%40');
  const purl = `pkg:npm/${encodedName}@${version}`;
  const bomRef = purl;

  rootDependsOn.push(bomRef);

  const comp = {
    "bom-ref": bomRef,
    type: wp.type,
    name: wp.name,
    version,
    description: pjson.description || "",
    scope: "required",
    licenses: [
      {
        license: {
          id: pjson.license || "MIT"
        }
      }
    ],
    purl
  };

  registeredComponents.set(purl, comp);

  // 2. Register Transitive Node Modules Dependencies
  const nmDir = path.join(rootDir, wp.dir, 'node_modules');
  if (fs.existsSync(nmDir)) {
    const pkgDeps = [];

    function scanDependencies(base) {
      let entries = [];
      try { entries = fs.readdirSync(base); } catch (e) { return; }

      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const full = path.join(base, entry);
        if (entry.startsWith('@')) {
          scanDependencies(full);
        } else {
          const depPjsonPath = path.join(full, 'package.json');
          if (fs.existsSync(depPjsonPath)) {
            try {
              const depPjson = JSON.parse(fs.readFileSync(depPjsonPath, 'utf8'));
              const depName = depPjson.name || entry;
              const depVersion = depPjson.version || '0.0.0';
              const depPurl = `pkg:npm/${depName.replace('@', '%40')}@${depVersion}`;
              
              pkgDeps.push(depPurl);

              if (!registeredComponents.has(depPurl)) {
                let lic = depPjson.license;
                if (!lic && Array.isArray(depPjson.licenses) && depPjson.licenses.length > 0) {
                  lic = depPjson.licenses.map(l => l.type || l.name || l).join(' OR ');
                }
                if (typeof lic === 'object' && lic !== null) lic = lic.type || lic.name;
                if (!lic) lic = "MIT"; // Fallback to standard permissive baseline

                registeredComponents.set(depPurl, {
                  "bom-ref": depPurl,
                  type: "library",
                  name: depName,
                  version: depVersion,
                  description: depPjson.description || "",
                  scope: "required",
                  licenses: [
                    {
                      license: {
                        id: typeof lic === 'string' && !lic.includes(' ') ? lic : undefined,
                        name: typeof lic === 'string' && lic.includes(' ') ? lic : (typeof lic === 'string' ? undefined : "MIT")
                      }
                    }
                  ],
                  purl: depPurl
                });
              }
            } catch (e) {}
          }
        }
      }
    }

    scanDependencies(nmDir);

    sbom.dependencies.push({
      ref: bomRef,
      dependsOn: Array.from(new Set(pkgDeps))
    });
  }
}

sbom.dependencies.unshift({
  ref: "pkg:generic/whatsap-automat@0.4.0",
  dependsOn: rootDependsOn
});

sbom.components = Array.from(registeredComponents.values());

fs.writeFileSync(outputFile, JSON.stringify(sbom, null, 2), 'utf8');
console.log(`✅ Successfully generated CycloneDX 1.5 JSON SBOM with ${sbom.components.length} components at: ${outputFile}`);
EOF
