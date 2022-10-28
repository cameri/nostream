const config = [
  'test/integration/features/**/*.feature',
  '--require-module ts-node/register',
  '--require test/integration/features/**/*.ts',
  '--require test/integration/features/*.ts',
  '--format @cucumber/pretty-formatter',
  '--publish',
].join(' ')

module.exports = {
  default: config,
}
