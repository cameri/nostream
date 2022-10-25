const config = [
  'test/integration/features/**/*.feature',
  '--require-module ts-node/register',
  '--require tests/integration/features/**/*.ts',
  '--format progress-bar',
  '--format json:report.json',
  '--publish-quiet',
].join(' ')

module.exports = {
  default: config,
}
