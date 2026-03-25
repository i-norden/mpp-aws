import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const tscBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);

const sourceRoots = ['src', 'test'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const forbiddenPatterns = [
  {
    allow: [/\/src\/db\/migrate-cli\.ts$/],
    label: 'console.log',
    regex: /\bconsole\.log\s*\(/g,
  },
  {
    allow: [],
    label: 'TODO/FIXME marker',
    regex: /\b(?:TODO|FIXME)\b/g,
  },
];

const violations = [];

for (const root of sourceRoots) {
  const fullRoot = path.join(projectRoot, root);
  if (!existsSync(fullRoot)) {
    continue;
  }

  walk(fullRoot);
}

if (!existsSync(tscBin)) {
  console.error(`TypeScript compiler not found at ${tscBin}`);
  process.exit(1);
}

const typecheck = spawnSync(tscBin, ['--noEmit'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

if (violations.length > 0) {
  console.error('Lint violations found:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('lint checks passed');

function walk(dir) {
  const entries = readdirSync(dir).sort();

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!sourceExtensions.has(path.extname(entry))) {
      continue;
    }

    const relativePath = path.relative(projectRoot, fullPath);
    const content = readFileSync(fullPath, 'utf8');

    for (const { allow, label, regex } of forbiddenPatterns) {
      if (allow.some((pattern) => pattern.test(fullPath))) {
        continue;
      }

      regex.lastIndex = 0;
      if (regex.test(content)) {
        violations.push(`${relativePath}: contains forbidden ${label}`);
      }
    }
  }
}
