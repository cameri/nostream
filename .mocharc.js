module.exports = {
  extension: ['ts'],
  require: ['ts-node/register'],
  reporter: 'mochawesome',
  slow: 75,
  'inline-diff': true,
  diff: true,
  'reporter-option': [
    'reportDir=.test-reports/unit',
    'reportFilename=index',
    'quiet=true',
    'json=false',
    'consoleReporter=spec',
  ],
}
