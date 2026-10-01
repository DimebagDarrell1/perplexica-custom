import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

// Exercise application modules without starting Next.js, databases, or model clients.
export function loadTs(filename, mocks = {}) {
  const cache = new Map();
  const root = path.resolve('src');
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = new Module(file);
    cache.set(file, mod);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    const require = createRequire(file);
    mod.require = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith('.') || id.startsWith('@/')) {
        const base = id.startsWith('@/')
          ? path.join(root, id.slice(2))
          : path.resolve(path.dirname(file), id);
        const target = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          path.join(base, 'index.ts'),
        ].find(
          (candidate) =>
            fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
        );
        if (target?.match(/\.tsx?$/)) return load(target);
      }
      return require(id);
    };
    mod._compile(
      ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
        fileName: file,
      }).outputText,
      file,
    );
    return mod.exports;
  }
  return load(filename);
}
