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

test('domain dependencies remain inside domain, independent of storage, services and I/O packages', async () => {
  const domain = join(sourceRoot, 'domain');
  const violations: string[] = [];
  for (const file of await sourceFiles(domain)) {
    for (const specifier of await moduleImports(file)) {
      if (!specifier.startsWith('.') || !inside(domain, resolve(dirname(file), specifier))) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('service depends on its own contracts and domain without database or transport implementations', async () => {
  const service = join(sourceRoot, 'service');
  const domain = join(sourceRoot, 'domain');
  const violations: string[] = [];
  for (const file of await sourceFiles(service)) {
    for (const specifier of await moduleImports(file)) {
      if (specifier === 'node:crypto') continue;
      const target = resolve(dirname(file), specifier);
      if (!specifier.startsWith('.') || (!inside(service, target) && !inside(domain, target))) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('frontend has no source import from either backend implementation', async () => {
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const files = [...await sourceFiles(join(frontend, 'src')), join(frontend, 'vite.config.js')];
  const backendDirectories = [fileURLToPath(new URL('../../Cortico/', import.meta.url)), fileURLToPath(new URL('../', import.meta.url))];
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of await moduleImports(file)) {
      const forbiddenName = /(?:^|[/\\])(?:Cortico|gameAgent)(?:[/\\]|$)/i.test(specifier);
      const target = resolve(dirname(file), specifier);
      if (forbiddenName || (specifier.startsWith('.') && backendDirectories.some(directory => inside(directory, target)))) violations.push(`${relative(frontend, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
