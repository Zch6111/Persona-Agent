import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    if (['node_modules', 'dist', 'public'].includes(entry.name)) return Promise.resolve([]);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return Promise.resolve(/\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []);
  }));
  return groups.flat();
}

async function moduleImports(file: string): Promise<string[]> {
  const content = await readFile(file, 'utf8');
  const tree = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      imports.push(expression && ts.isStringLiteralLike(expression) ? expression.text : '<dynamic>');
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      imports.push(argument && ts.isStringLiteralLike(argument) ? argument.text : '<dynamic>');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function inside(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

test('source has exactly application and adapter; business packages contain flat responsibility files', async () => {
  assert.deepEqual((await readdir(sourceRoot)).sort(), ['adapter', 'application']);
  const application = join(sourceRoot, 'application');
  assert.deepEqual((await readdir(application)).sort(), ['conversation', 'inference', 'inspection', 'memory', 'persona']);
  for (const business of await readdir(application)) {
    assert.deepEqual((await readdir(join(application, business))).sort(), ['model.ts', 'repository.ts', 'usecase.ts']);
  }
  for (const business of await readdir(join(sourceRoot, 'adapter'))) {
    const entries = await readdir(join(sourceRoot, 'adapter', business), { withFileTypes: true });
    assert.deepEqual(entries.filter(entry => entry.isDirectory() && !(business === 'web' && ['node_modules', 'dist', 'public'].includes(entry.name))).map(entry => entry.name), []);
  }
});

test('business models depend only on business models without services or I/O', async () => {
  const application = join(sourceRoot, 'application');
  const violations: string[] = [];
  for (const file of (await sourceFiles(application)).filter(file => file.endsWith('/model.ts'))) {
    for (const specifier of await moduleImports(file)) {
      const target = resolve(dirname(file), specifier);
      if (!specifier.startsWith('.') || !inside(application, target) || !target.endsWith('/model.js')) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('application never imports adapters, network libraries, filesystems or process configuration', async () => {
  const application = join(sourceRoot, 'application');
  const violations: string[] = [];
  for (const file of await sourceFiles(application)) {
    for (const specifier of await moduleImports(file)) {
      if (specifier === 'node:crypto') continue;
      const target = resolve(dirname(file), specifier);
      if (!specifier.startsWith('.') || !inside(application, target)) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
    const content = await readFile(file, 'utf8');
    if (/\b(?:fetch|setInterval|setTimeout)\s*\(|\bprocess\.(?:env|on|once|kill)\b/.test(content)) violations.push(`${relative(sourceRoot, file)} contains external runtime access`);
  }
  assert.deepEqual(violations, []);
});

test('repository files contain interfaces and model types without usecases or implementations', async () => {
  const violations: string[] = [];
  for (const file of (await sourceFiles(join(sourceRoot, 'application'))).filter(file => file.endsWith('/repository.ts'))) {
    for (const specifier of await moduleImports(file)) {
      if (!specifier.endsWith('/model.js')) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
    const content = await readFile(file, 'utf8');
    if (/\bclass\s|\bfunction\s/.test(content)) violations.push(`${relative(sourceRoot, file)} contains implementation`);
  }
  assert.deepEqual(violations, []);
});

test('frontend stays independent and imports only its own source or browser build dependencies', async () => {
  const frontend = join(sourceRoot, 'adapter/web');
  const files = await sourceFiles(frontend);
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of await moduleImports(file)) {
      const forbiddenName = /(?:^|[/\\])(?:Cortico|gameAgent)(?:[/\\]|$)/i.test(specifier);
      const target = resolve(dirname(file), specifier);
      if (forbiddenName || (specifier.startsWith('.') && !inside(frontend, target))) violations.push(`${relative(frontend, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
