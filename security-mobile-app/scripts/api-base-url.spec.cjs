const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'api-base-url.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('exports', 'module', 'require', compiled)(
  moduleUnderTest.exports,
  moduleUnderTest,
  require,
);

const { LIVE_API_BASE_URL, resolveApiBaseUrl } = moduleUnderTest.exports;

assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'localhost',
  }),
  'http://localhost:3000',
  'localhost web must default to the local NestJS backend',
);
assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: '127.0.0.1',
  }),
  'http://localhost:3000',
  '127.0.0.1 web must default to the local NestJS backend',
);
assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'dashboard.observantsecurity.co.uk',
  }),
  LIVE_API_BASE_URL,
  'production web must retain the configured live API',
);
assert.equal(
  resolveApiBaseUrl({ configuredUrl: LIVE_API_BASE_URL }),
  LIVE_API_BASE_URL,
  'native must retain the configured API URL',
);
assert.equal(
  resolveApiBaseUrl({
    environmentUrl: 'https://explicit.example.test',
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'localhost',
  }),
  'https://explicit.example.test',
  'an explicit environment override must have highest precedence',
);

console.log('API base URL selection regression tests passed (5/5).');
