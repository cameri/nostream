const base = [
  'test/integration/features/**/*.feature',
  '--require-module ts-node/register',
  '--require test/integration/features/**/*.ts',
  '--require test/integration/features/*.ts',
  '--publish-quiet',
].join(' ')

const config = [
  base,
  '--format @cucumber/pretty-formatter',
  '--format html:.test-reports/integration/report.html',
  '--format json:.test-reports/integration/report.json',
  '--publish',
].join(' ')

module.exports = {
  default: config,
  cover: base,
}
