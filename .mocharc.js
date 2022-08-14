module.exports = {
  extension: ['ts'],
  require: ['ts-node/register/transpile-only', 'source-map-support/register'],
  reporter: 'mochawesome',
  slow: 75,
  sorted: true,
  'inline-diff': true,
  diff: true,
  'reporter-option': [
    'reportDir=.test-report',
    'reportFilename=index',
    'quiet=true',
    'json=false',
    'consoleReporter=spec',
  ],
}
