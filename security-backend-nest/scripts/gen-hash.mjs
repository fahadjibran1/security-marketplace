// Generate bcrypt hash for staging test accounts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('../node_modules/bcrypt/bcrypt.js');

const password = process.argv[2] || 'TestPass!2026';
const hash = await bcrypt.hash(password, 10);
console.log(hash);
