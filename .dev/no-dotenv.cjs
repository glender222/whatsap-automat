'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');
const requireBackend = createRequire(path.resolve(__dirname, '../WhatsaapWeb-JS/package.json'));
let dotenvPath;
try {
  dotenvPath = requireBackend.resolve('dotenv');
} catch (error) {
  // npm ci also receives NODE_OPTIONS before the backend dependencies exist.
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
if (dotenvPath) {
  const dotenv = requireBackend(dotenvPath);
  const ignoreLocalFiles = () => ({ parsed: {} });
  dotenv.config = ignoreLocalFiles;
  dotenv.configDotenv = ignoreLocalFiles;
}
