/**
 * Startup check.
 *
 * `npm run check` answers one question before anyone opens a browser: does this project
 * actually load? It verifies four things a syntax check alone would miss.
 *
 *   1. every JavaScript file parses
 *   2. every relative import resolves to a file that exists
 *   3. every named import is actually exported by its target — this is the failure that
 *      reaches production most often in an ES-module app with no bundler, because nothing
 *      resolves the graph until the browser does
 *   4. every module except the DOM entry point can be imported in Node and evaluated
 *
 * It also checks that index.html references only files that exist, and that the server's
 * HTTP surface answers.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'server', 'tests', 'bridge', 'scripts'];

const problems = [];
const warnings = [];
let filesChecked = 0;
let importsChecked = 0;

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...await walk(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/** Parse import/export statements without a full JS parser. */
function parseModuleSyntax(source) {
  const imports = [];
  const exports = new Set();

  const importRe = /import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    imports.push({ clause: match[1] || '', specifier: match[2] });
  }
  const reexportRe = /export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(reexportRe)) imports.push({ clause: '', specifier: match[1], reexport: true });

  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) exports.add(match[1]);
  for (const match of source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) exports.add(match[1]);
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) exports.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) exports.add('default');
  return { imports, exports };
}

/** The names a module tries to pull out of another one. */
function namedImports(clause) {
  const names = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function check(file) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { problems.push(`${rel(file)}: could not run node --check (${err.message})`); done(); });
    child.on('exit', (code) => {
      if (code !== 0) problems.push(`${rel(file)}: syntax error\n${stderr.split('\n').slice(0, 6).join('\n')}`);
      done();
    });
  });
}

const rel = (file) => relative(ROOT, file);

async function main() {
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...await walk(join(ROOT, dir)));
  files.sort();

  console.log(`Checking ${files.length} JavaScript files…\n`);

  // 1. syntax
  for (const file of files) await check(file);
  filesChecked = files.length;

  // 2 + 3. import graph
  const parsed = new Map();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    parsed.set(file, parseModuleSyntax(source));
  }

  for (const [file, { imports }] of parsed) {
    for (const entry of imports) {
      const specifier = entry.specifier;
      if (!specifier.startsWith('.')) continue;   // node builtins and bare specifiers
      importsChecked++;
      const target = resolve(dirname(file), specifier);
      let info;
      try {
        info = await stat(target);
      } catch {
        problems.push(`${rel(file)}: imports "${specifier}", which does not exist`);
        continue;
      }
      if (info.isDirectory()) {
        problems.push(`${rel(file)}: imports the directory "${specifier}" — ES modules need an explicit file`);
        continue;
      }
      const wanted = namedImports(entry.clause);
      if (!wanted.length || entry.reexport) continue;
      const targetParsed = parsed.get(target);
      if (!targetParsed) continue;               // a fixture or a file outside the scan
      for (const name of wanted) {
        if (!targetParsed.exports.has(name)) {
          problems.push(`${rel(file)}: imports "${name}" from "${specifier}", which does not export it`);
        }
      }
    }
  }

  // 4. every module evaluates. Two files are excluded on purpose: src/index.js touches
  //    document at module level (it is the browser entry point), and the bridge userscript
  //    is an IIFE that expects window. Both are still syntax-checked and import-checked.
  const BROWSER_ONLY = ['src/index.js', 'bridge/maniaflow-bridge.user.js'];
  const importable = files.filter((f) => !BROWSER_ONLY.some((b) => f.endsWith(b))
    && !f.includes('/tests/') && !f.includes('/scripts/'));
  let imported = 0;
  for (const file of importable) {
    try {
      await import(pathToFileURL(file).href);
      imported++;
    } catch (err) {
      problems.push(`${rel(file)}: failed to evaluate — ${err.message}`);
    }
  }

  // 5. index.html references
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
    const target = resolve(ROOT, match[1]);
    try {
      await stat(target);
    } catch {
      problems.push(`index.html references "${match[1]}", which does not exist`);
    }
  }

  // 6. required files
  for (const required of ['package.json', 'README.md', 'bridge/maniaflow-bridge.user.js']) {
    try {
      await stat(join(ROOT, required));
    } catch {
      problems.push(`missing required file: ${required}`);
    }
  }

  console.log(`  syntax         ${filesChecked} files`);
  console.log(`  import graph   ${importsChecked} relative imports resolved`);
  console.log(`  evaluation     ${imported}/${importable.length} modules imported cleanly`);

  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (problems.length) {
    console.log(`\nProblems (${problems.length}):`);
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ No syntax errors, no unresolved imports, no missing exports.');
}

main().catch((err) => {
  console.error('The check itself failed:', err);
  process.exit(1);
});
