/**
 * Pilot release — deployment manifest certification (no database, no network).
 *
 * render.yaml is the deployment source of truth. Production startup validates its environment fail-closed
 * (validateRuntimeEnv); this proves the manifest actually declares every variable that validation requires, so a
 * Blueprint sync prompts for each secret instead of the API crash-looping on first boot.
 *
 *   MANIFEST-1  every variable production validation needs is declared (secrets as sync:false / generated)
 *   MANIFEST-2  no secret value is committed (secrets are never `value:`)
 *   MANIFEST-3  Guard data keys are declared as dashboard secrets and production refuses to boot without them
 *   MANIFEST-4  server clock is UTC; synchronize is false; one trusted proxy hop
 *   MANIFEST-5  manual deploys only, single instance, migrations run pre-deploy, release branch (never main)
 *   MANIFEST-6  the release CI gates run on the manifest's release branch
 */
import { equal, ok, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateRuntimeEnv } from '../src/config/runtime-env';

const root = resolve(__dirname, '../..');
const manifest = readFileSync(resolve(root, 'render.yaml'), 'utf8').replace(/\r\n/g, '\n');

type EnvVar = { key: string; value?: string; sync?: boolean; generateValue?: boolean };
function parseEnvVars(text: string): Map<string, EnvVar> {
  const vars = new Map<string, EnvVar>();
  let current: EnvVar | null = null;
  let inEnv = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s+envVars:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (!inEnv) continue;
    const key = line.match(/^\s+- key:\s*(\S+)\s*$/);
    if (key) {
      current = { key: key[1] };
      vars.set(current.key, current);
      continue;
    }
    if (!current) continue;
    const value = line.match(/^\s+value:\s*"?([^"]*)"?\s*$/);
    if (value) current.value = value[1];
    if (/^\s+sync:\s*false\s*$/.test(line)) current.sync = false;
    if (/^\s+generateValue:\s*true\s*$/.test(line)) current.generateValue = true;
  }
  return vars;
}
const scalar = (name: string) => manifest.match(new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`, 'm'))?.[1];

const env = parseEnvVars(manifest);
const isSecret = (v?: EnvVar) => Boolean(v && v.value === undefined && (v.sync === false || v.generateValue));

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void) => tests.push([name, run]);

test('MANIFEST-1 every variable required by production validation is declared', () => {
  const required = [
    'NODE_ENV', 'JWT_SECRET', 'CORS_ORIGIN', 'DATABASE_URL', 'DATABASE_SYNCHRONIZE', 'DATABASE_SSL', 'DATABASE_CA_CERT',
    'EVIDENCE_STORAGE_ENDPOINT', 'EVIDENCE_STORAGE_REGION', 'EVIDENCE_STORAGE_BUCKET', 'EVIDENCE_STORAGE_ACCESS_KEY_ID',
    'EVIDENCE_STORAGE_SECRET_ACCESS_KEY', 'GUARD_DATA_ENCRYPTION_KEY', 'GUARD_DATA_HMAC_KEY', 'TZ', 'TRUST_PROXY',
  ];
  for (const key of required) ok(env.has(key), `render.yaml does not declare ${key}`);
});

test('MANIFEST-2 secrets are never committed as values', () => {
  for (const key of [
    'JWT_SECRET', 'DATABASE_URL', 'DATABASE_CA_CERT', 'EVIDENCE_STORAGE_ACCESS_KEY_ID', 'EVIDENCE_STORAGE_SECRET_ACCESS_KEY',
    'EVIDENCE_STORAGE_ENDPOINT', 'EVIDENCE_STORAGE_BUCKET', 'GUARD_DATA_ENCRYPTION_KEY', 'GUARD_DATA_HMAC_KEY', 'CORS_ORIGIN',
  ]) {
    ok(isSecret(env.get(key)), `${key} must be a dashboard secret (sync:false) or generated, not a committed value`);
  }
  ok(!/[0-9a-f]{64}/i.test(manifest), 'manifest must not contain a 64-character hex key value');
});

test('MANIFEST-3 Guard data keys are secrets and production fails closed without them', () => {
  ok(env.get('GUARD_DATA_ENCRYPTION_KEY')?.sync === false && env.get('GUARD_DATA_HMAC_KEY')?.sync === false);
  const complete = {
    NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), CORS_ORIGIN: 'https://portal.example', DATABASE_URL: 'postgresql://localhost/db',
    DATABASE_SSL: 'true', DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----', DATABASE_SYNCHRONIZE: 'false', EVIDENCE_STORAGE_ENDPOINT: 'https://storage.example',
    EVIDENCE_STORAGE_REGION: 'auto', EVIDENCE_STORAGE_BUCKET: 'b', EVIDENCE_STORAGE_ACCESS_KEY_ID: 'k', EVIDENCE_STORAGE_SECRET_ACCESS_KEY: 's',
    GUARD_DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4), GUARD_DATA_HMAC_KEY: 'fedcba9876543210'.repeat(4),
  };
  validateRuntimeEnv(complete);
  for (const key of ['GUARD_DATA_ENCRYPTION_KEY', 'GUARD_DATA_HMAC_KEY']) {
    throws(() => validateRuntimeEnv({ ...complete, [key]: '' }), new RegExp(key), `${key} missing must stop production boot`);
    throws(() => validateRuntimeEnv({ ...complete, [key]: 'abc' }), new RegExp(key), `${key} malformed must stop production boot`);
  }
  throws(() => validateRuntimeEnv({ ...complete, GUARD_DATA_HMAC_KEY: complete.GUARD_DATA_ENCRYPTION_KEY }), /different/);
});

test('MANIFEST-4 UTC clock, no synchronize, single proxy hop', () => {
  equal(env.get('TZ')?.value, 'UTC');
  equal(env.get('DATABASE_SYNCHRONIZE')?.value, 'false');
  equal(env.get('NODE_ENV')?.value, 'production');
  equal(env.get('TRUST_PROXY')?.value, '1');
  equal(env.get('DATABASE_SSL')?.value, 'true');
  equal(env.get('ENABLE_SWAGGER')?.value, 'false');
});

test('MANIFEST-5 manual deploy, one instance, migrations pre-deploy, release branch', () => {
  equal(scalar('autoDeployTrigger'), 'off');
  equal(scalar('numInstances'), '1');
  ok(/preDeployCommand:\s*npm run migration:run:prod/.test(manifest), 'migrations must run pre-deploy');
  ok(/healthCheckPath:\s*\/health\/ready/.test(manifest));
  const branch = scalar('branch') ?? '';
  ok(/^release\//.test(branch), `deployment branch must be a release branch, got ${branch}`);
});

test('MANIFEST-6 CI release gates run on the manifest branch', () => {
  const branch = scalar('branch')!;
  for (const file of ['s4-backend-release-gate.yml', 's4-mobile-release-gate.yml']) {
    const workflow = readFileSync(resolve(root, '.github/workflows', file), 'utf8').replace(/\r\n/g, '\n');
    const pushBlock = workflow.match(/push:\n\s+branches:\n((?:\s+- .+\n)+)/)?.[1] ?? '';
    const prBlock = workflow.match(/pull_request:\n\s+branches:\n((?:\s+- .+\n)+)/)?.[1] ?? '';
    ok(pushBlock.includes(`- ${branch}`), `${file} does not run on push to ${branch}`);
    ok(prBlock.includes(`- ${branch}`), `${file} does not run on pull requests to ${branch}`);
  }
});

let passed = 0;
for (const [name, run] of tests) {
  run();
  passed += 1;
  console.log(`PASS ${passed}/${tests.length} ${name}`);
}
console.log(JSON.stringify({ event: 'deploy_manifest_tests_passed', tests: passed }));
