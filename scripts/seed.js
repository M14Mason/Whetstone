#!/usr/bin/env node
'use strict';

const { init } = require('../lib/db');
const { seed } = require('../lib/questions');

const reset = process.argv.includes('--reset');

init();
try {
  seed({ reset });
  console.log(reset ? 'Question bank reset and reseeded.' : 'Question bank up to date.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
