#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const distEntry = path.join(__dirname, '..', 'dist', 'index.js');
const srcEntry = path.join(__dirname, '..', 'src', 'index.ts');

async function main() {
  let runCli;
  if (fs.existsSync(distEntry)) {
    runCli = require(distEntry).runCli;
  } else if (fs.existsSync(srcEntry)) {
    try {
      require('tsx/cjs');
      runCli = require(srcEntry).runCli;
    } catch {
      runCli = require(distEntry).runCli;
    }
  } else {
    console.error('Error: CLI entrypoint not found. Please run "npm run build" in packages/cli.');
    process.exit(1);
  }

  const exitCode = await runCli(process.argv.slice(2));
  process.exit(typeof exitCode === 'number' ? exitCode : 0);
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err?.message || err);
  process.exit(1);
});
