import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Skip Husky installation in environments where hooks are not needed
if (
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true' ||
  process.env.HUSKY === '0' ||
  !existsSync('.git')
) {
  process.exit(0);
}

try {
  execSync('npx husky install', { stdio: 'ignore' });
} catch {
  process.exit(0);
}
