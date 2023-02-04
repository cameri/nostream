module.exports = {
  extends: ['@commitlint/config-conventional'],
	parserPreset: 'conventional-changelog-conventionalcommits',
	rules: {
		'body-max-line-length': [2, 'always', 250],
		'subject-case': [0, 'always'],
		'header-case': [0, 'always'],
		'body-case': [0, 'always'],
		'footer-max-line-length': [0, 'always'],
  },
}
