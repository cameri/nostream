import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Skip Husky installation in environments where hooks are not needed
if (
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true' ||
  process.env.HUSKY === '0' ||
  !existsSync(path.join(process.cwd(), '.git'))
) {
  process.exit(0);
}

const require = createRequire(path.join(repoRoot, 'package.json'));
try {
  require.resolve('husky');
} catch {
  process.exit(0);
}

try {
  execSync('pnpm exec husky install', { cwd: repoRoot, stdio: 'ignore', timeout: 8000 });
} catch {
  process.exit(0);
}
