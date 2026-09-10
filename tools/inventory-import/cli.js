#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { planInventoryImport } = require('./plan');

function readJson(file) {
  if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error('Input exceeds 25 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

try {
  const [snapshotPath, contextPath, now] = process.argv.slice(2);
  if (!snapshotPath || !contextPath || process.argv.length > 5) throw new Error('Usage: node tools/inventory-import/cli.js snapshot.json context.json [UTC-now]');
  const result = planInventoryImport(readJson(snapshotPath), readJson(contextPath), now);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'blocked' ? 2 : 0;
} catch {
  process.stderr.write('Не удалось прочитать входные файлы. Нужны snapshot.json, context.json и необязательное время UTC; JSON-файлы до 25 МиБ.\n');
  process.exitCode = 1;
}
