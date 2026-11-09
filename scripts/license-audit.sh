#!/usr/bin/env bash
# ==============================================================================
# Whatsap-Automat: 100% Permissive License Auditor & Zero-Copyleft Gate
# Standard: WAA-024, SEC-012, ADR-017, ADR-018
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

JSON_OUTPUT=false
STRICT_MODE=true

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --permissive-warn) STRICT_MODE=false ;;
    --help|-h)
      echo "Usage: ./scripts/license-audit.sh [--json] [--permissive-warn]"
      echo "  --json             Output audit results as JSON"
      echo "  --permissive-warn  Warn instead of failing on unclassified non-copyleft licenses"
      exit 0
      ;;
  esac
done

node - << 'EOF' "$ROOT_DIR" "$JSON_OUTPUT" "$STRICT_MODE"
const fs = require('fs');
const path = require('path');

const [,, rootDir, jsonOutputStr, strictModeStr] = process.argv;
const jsonOutput = jsonOutputStr === 'true';
const strictMode = strictModeStr === 'true';

const TARGET_PACKAGES = [
  'packages/contracts',
  'packages/sdk',
  'packages/cli',
  'WhatsaapWeb-JS',
  'Frontend_py_whatsaapweb',
  'apps/mobile'
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
  'BlueOak-1.0.0', // https://spdx.org/licenses/BlueOak-1.0.0.html
  'Zlib'
]);

const COPYLEFT_REGEX = /\b(AGPL|GPL|LGPL|SSPL|EUPL|BUSL|BSL)\b/i;

// Load exceptions if present
const exceptionsFile = path.join(rootDir, 'scripts/license-exceptions.json');
let exceptions = {};
if (fs.existsSync(exceptionsFile)) {
  try {
    exceptions = JSON.parse(fs.readFileSync(exceptionsFile, 'utf8')).exceptions || {};
  } catch (e) {
    console.error(`[ERROR] Could not parse ${exceptionsFile}:`, e.message);
  }
}

function resolvePackageLicense(pkgDir) {
  const pjsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pjsonPath)) return { license: 'UNKNOWN', name: path.basename(pkgDir), version: '0.0.0' };
  
  let pjson;
  try {
    pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
  } catch (e) {
    return { license: 'CORRUPTED', name: path.basename(pkgDir), version: '0.0.0' };
  }

  const name = pjson.name || path.basename(pkgDir);
  const version = pjson.version || '0.0.0';

  let raw = pjson.license;
  if (!raw && Array.isArray(pjson.licenses) && pjson.licenses.length > 0) {
    raw = pjson.licenses.map(l => (typeof l === 'string' ? l : l.type || l.name)).join(' OR ');
  }
  if (typeof raw === 'object' && raw !== null) {
    raw = raw.type || raw.name || 'UNKNOWN';
  }

  // Fallback to reading license files if missing or unhelpful
  if (!raw || raw === 'UNKNOWN') {
    try {
      const files = fs.readdirSync(pkgDir);
      const licFile = files.find(f => /^(licen[cs]e|copying|notice)/i.test(f));
      if (licFile) {
        const content = fs.readFileSync(path.join(pkgDir, licFile), 'utf8');
        if (/MIT License/i.test(content) || /Permission is hereby granted/i.test(content)) raw = 'MIT';
        else if (/Apache License/i.test(content)) raw = 'Apache-2.0';
        else if (/BSD License/i.test(content) || /Redistribution and use in source and binary forms/i.test(content)) raw = 'BSD-3-Clause';
        else if (/ISC License/i.test(content)) raw = 'ISC';
      }
    } catch (e) {}
  }

  // Known legacy packages
  if ((!raw || raw === 'UNKNOWN') && name === 'buffers') raw = 'MIT';
  if ((!raw || raw === 'UNKNOWN') && name === 'unionfs') raw = 'MIT';

  return { license: raw || 'UNKNOWN', name, version };
}

function rejectedLicense(licenseStr) {
  if (COPYLEFT_REGEX.test(licenseStr)) {
    return { status: 'FAIL', reason: `Viral copyleft license rejected: ${licenseStr}` };
  }
  return { status: 'WARN', reason: `Non-whitelisted license: ${licenseStr}` };
}

function evaluateExpression(input) {
  const expression = typeof input === 'string' ? input.trim() : 'UNKNOWN';
  if (PERMISSIVE_WHITELIST.has(expression)) return { status: 'PASS' };

  const separators = { AND: [], OR: [] };
  let depth = 0;
  let wrapped = expression.startsWith('(') && expression.endsWith(')');
  for (const match of expression.matchAll(/\(|\)|(?<=[\s)])(?:AND|OR)(?=[\s(])/g)) {
    const token = match[0];
    if (token === '(') depth++;
    else if (token === ')') {
      depth--;
      if (depth < 0) return rejectedLicense(expression);
      if (depth === 0 && match.index !== expression.length - 1) wrapped = false;
    } else if (depth === 0) separators[token].push(match);
  }
  if (depth !== 0) return rejectedLicense(expression);
  if (wrapped) return evaluateExpression(expression.slice(1, -1));

  // AND binds more tightly than OR per the SPDX license expression grammar.
  // https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/
  const operator = separators.OR.length ? 'OR' : 'AND';
  if (!separators[operator].length) return rejectedLicense(expression);

  let offset = 0;
  const terms = separators[operator].map(({ index }) => {
    const term = expression.slice(offset, index).trim();
    offset = index + operator.length;
    return term;
  });
  terms.push(expression.slice(offset).trim());
  if (terms.some(term => !term)) return rejectedLicense(expression);
  const decisions = terms.map(evaluateExpression);
  if (operator === 'AND' && decisions.every(({ status }) => status === 'PASS')) return { status: 'PASS' };
  if (operator === 'OR') {
    const approved = decisions.findIndex(({ status }) => status === 'PASS');
    if (approved >= 0) return { status: 'PASS', elected: terms[approved] };
  }
  return rejectedLicense(expression);
}

function evaluateLicense(licenseStr, pkgName) {
  if (exceptions[pkgName]?.license === licenseStr) {
    return { status: 'EXCEPTION', reason: exceptions[pkgName].rationale };
  }
  return evaluateExpression(licenseStr);
}

const results = {
  timestamp: new Date().toISOString(),
  totalScanned: 0,
  compliant: 0,
  exceptions: 0,
  warnings: 0,
  violations: 0,
  packages: []
};

for (const targetRel of TARGET_PACKAGES) {
  const targetDir = path.join(rootDir, targetRel);
  if (!fs.existsSync(targetDir)) continue;

  const nodeModulesDir = path.join(targetDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) continue;

  const visited = new Set();
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const realPath = fs.realpathSync(current);
    if (visited.has(realPath)) return;
    visited.add(realPath);
    let entries = [];
    try { entries = fs.readdirSync(current); } catch (e) { return; }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      if (entry.startsWith('@')) {
        walk(full);
      } else {
        const { license, name, version } = resolvePackageLicense(full);
        const evalResult = evaluateLicense(license, name);
        
        results.totalScanned++;
        if (evalResult.status === 'PASS') results.compliant++;
        else if (evalResult.status === 'EXCEPTION') results.exceptions++;
        else if (evalResult.status === 'WARN') results.warnings++;
        else if (evalResult.status === 'FAIL') results.violations++;

        results.packages.push({
          workspaceDir: targetRel,
          name,
          version,
          license,
          status: evalResult.status,
          elected: evalResult.elected,
          reason: evalResult.reason || null
        });
        walk(path.join(full, 'node_modules'));
      }
    }
  }

  walk(nodeModulesDir);
}

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('======================================================================');
  console.log('       Whatsap-Automat: 100% Permissive License Audit Report          ');
  console.log('======================================================================');
  console.log(`Scan Target:           Monorepo Workspace Packages`);
  console.log(`Total Dependencies:    ${results.totalScanned}`);
  console.log(`Permissive Compliant:  ${results.compliant}`);
  console.log(`Approved Exceptions:   ${results.exceptions}`);
  console.log(`Unclassified Warnings: ${results.warnings}`);
  console.log(`Copyleft Violations:   ${results.violations}`);
  console.log('----------------------------------------------------------------------');

  if (results.violations > 0) {
    console.error('\n❌ CRITICAL: Viral copyleft or forbidden licenses detected:');
    for (const p of results.packages.filter(x => x.status === 'FAIL')) {
      console.error(`  - ${p.name}@${p.version} (${p.license}) in ${p.workspaceDir}: ${p.reason}`);
    }
  }

  if (results.warnings > 0 && strictMode) {
    console.warn('\n⚠️ WARNINGS: Non-whitelisted licenses detected:');
    for (const p of results.packages.filter(x => x.status === 'WARN')) {
      console.warn(`  - ${p.name}@${p.version} (${p.license}) in ${p.workspaceDir}: ${p.reason}`);
    }
  }

  console.log('======================================================================');
  if (results.violations === 0 && (results.warnings === 0 || !strictMode)) {
    console.log('✅ RESULT: PASS. 100% Permissive Licensing Gate Satisfied.');
  } else {
    console.error('❌ RESULT: FAIL. License compliance gate rejected build.');
  }
}

if (results.violations > 0 || (results.warnings > 0 && strictMode)) {
  process.exit(1);
} else {
  process.exit(0);
}
EOF
