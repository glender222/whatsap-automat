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
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const [,, rootDir, outputFile] = process.argv;
const workspaceTypes = {
  'Frontend_py_whatsaapweb': 'application',
  'WhatsaapWeb-JS': 'application',
  'apps/mobile': 'application',
  'packages/cli': 'application',
  'packages/contracts': 'library',
  'packages/sdk': 'library',
};
const rootRef = 'pkg:generic/whatsap-automat@0.4.0';
const property = (name, value) => ({ name, value });

const projects = new Map(Object.keys(workspaceTypes).sort().map((dir) => {
  const input = fs.readFileSync(path.join(rootDir, dir, 'package-lock.json'));
  const lock = JSON.parse(input);
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']?.name || !lock.packages[''].version) {
    throw new Error(`Expected an npm v3 lockfile with a root package in ${dir}`);
  }
  const packages = new Map(Object.entries(lock.packages).filter(([location, entry]) =>
    (location === '' || location.startsWith('node_modules/')) && !entry.extraneous));
  return [dir, {
    dir,
    packages,
    hash: createHash('sha256').update(input).digest('hex'),
  }];
}));

function ref(project, location = '') {
  return `whatsap:${project.dir}${location ? '#' + location : ''}`;
}

function linkedProject(project, entry) {
  const targetDir = path.posix.normalize(path.posix.join(project.dir, entry.resolved));
  const target = projects.get(targetDir);
  if (!target) throw new Error(`Unresolved local npm link in ${project.dir} to ${targetDir}`);
  return target;
}

function nameAt(location) {
  return ('/' + location).split('/node_modules/').at(-1);
}

function component(project, location, entry) {
  const target = entry.link ? linkedProject(project, entry) : undefined;
  const manifest = target?.packages.get('') ?? entry;
  const name = manifest.name ?? nameAt(location);
  if (!name || !manifest.version) throw new Error(`Missing npm identity at ${ref(project, location)}`);

  const properties = [
    property('whatsap:workspace', project.dir),
    property('cdx:npm:package:path', location),
    property('whatsap:npm:scope', entry.dev ? 'development' :
      entry.devOptional ? 'development-optional' : entry.optional ? 'optional' : 'runtime'),
  ];
  if (entry.optional) properties.push(property('whatsap:npm:optional', 'true'));
  if (entry.peer) properties.push(property('whatsap:npm:peer', 'true'));
  if (entry.os) properties.push(property('whatsap:npm:os', [...entry.os].sort().join(',')));
  if (entry.cpu) properties.push(property('whatsap:npm:cpu', [...entry.cpu].sort().join(',')));
  if (entry.libc) properties.push(property('whatsap:npm:libc', [...entry.libc].sort().join(',')));
  if (target) properties.push(property('whatsap:npm:local-link', target.dir));

  return {
    'bom-ref': ref(project, location),
    type: location ? 'library' : workspaceTypes[project.dir],
    name,
    version: manifest.version,
    purl: `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(manifest.version)}`,
    scope: entry.dev ? 'excluded' : entry.optional || entry.devOptional ? 'optional' : 'required',
    ...(typeof manifest.license === 'string' && manifest.license && manifest.license !== 'UNLICENSED'
      ? { licenses: [{ license: { name: manifest.license } }] } : {}),
    properties,
  };
}

function findPlacement(project, location, name) {
  let current = location;
  for (;;) {
    if (path.posix.basename(current) !== 'node_modules') {
      const candidate = path.posix.join(current, 'node_modules', name);
      if (project.packages.has(candidate)) return candidate;
    }
    if (!current) return undefined;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

function dependenciesOf(project, location, entry) {
  if (entry.link) return [ref(linkedProject(project, entry))];

  const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
  for (const [name, metadata] of Object.entries(entry.peerDependenciesMeta ?? {})) {
    if (metadata.optional) optional.add(name);
  }
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
    ...(!location ? Object.keys(entry.devDependencies ?? {}) : []),
  ]);
  const resolved = new Set();
  for (const name of names) {
    const placement = findPlacement(project, location, name);
    if (placement) resolved.add(ref(project, placement));
    else if (!optional.has(name)) {
      throw new Error(`Unresolved npm dependency ${name} in ${ref(project, location)}`);
    }
  }
  return [...resolved].sort();
}

const components = [];
const dependencies = [{ ref: rootRef, dependsOn: [...projects.values()].map(project => ref(project)) }];
for (const project of projects.values()) {
  for (const location of [...project.packages.keys()].sort()) {
    const entry = project.packages.get(location);
    components.push(component(project, location, entry));
    dependencies.push({ ref: ref(project, location), dependsOn: dependenciesOf(project, location, entry) });
  }
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      'bom-ref': rootRef,
      type: 'application',
      name: 'whatsap-automat',
      version: '0.4.0',
      purl: rootRef,
    },
    properties: [...projects.values()].map(project =>
      property(`whatsap:lock-sha256:${project.dir}`, project.hash)),
  },
  components,
  dependencies,
};

fs.writeFileSync(outputFile, JSON.stringify(sbom, null, 2) + '\n', 'utf8');
console.log(`Generated lockfile-based CycloneDX SBOM with ${components.length} components at ${outputFile}`);
EOF
