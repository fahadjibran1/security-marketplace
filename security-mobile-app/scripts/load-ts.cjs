// Shared TypeScript module loader for the node spec scripts.
//
// The repo's convention is that pure presentation logic is EXECUTED in tests through the TypeScript
// compiler that is already a dev dependency — no test framework, no bundler. Each spec used to carry its
// own copy of this helper, and each copy could only load a module whose imports were all `import type`
// (erased at transpile time). The moment a pure module legitimately imported another pure module at
// runtime, every spec that loaded it failed with "Cannot find module './thing'".
//
// This resolves relative imports between source modules the same way the bundler would, so a pure module
// may depend on another pure module. It deliberately does NOT resolve anything else: a spec that reaches
// for react-native or expo-constants should fail loudly rather than silently load a stub, because those
// modules do not belong in logic that claims to be pure.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

/** Resolves './x' / '../x' to an actual .ts/.tsx file on disk, or null when there isn't one. */
function resolveRelative(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Transpiles and executes a source module, caching by absolute path so a diamond dependency is only
 * evaluated once (and so a cycle cannot recurse forever).
 */
function loadFrom(absolutePath, cache) {
  const cached = cache.get(absolutePath);
  if (cached) return cached.exports;

  const source = fs.readFileSync(absolutePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = { exports: {} };
  cache.set(absolutePath, mod);

  const localRequire = (request) => {
    if (request.startsWith('.')) {
      const resolved = resolveRelative(absolutePath, request);
      if (resolved) return loadFrom(resolved, cache);
    }
    return require(request);
  };

  new Function('module', 'exports', 'require', output)(mod, mod.exports, localRequire);
  return mod.exports;
}

/** Loads a repo-relative source file, e.g. loadTs('src/components/company/ukDate.ts'). */
function loadTs(relativePath) {
  return loadFrom(path.join(ROOT, relativePath), new Map());
}

module.exports = { loadTs, ROOT };
