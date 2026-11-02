module.exports = {
  extends: ['@commitlint/config-conventional'],
	parserPreset: 'conventional-changelog-conventionalcommits',
	// One commit on `main` cannot follow the convention: a code-of-conduct file was
	// added through the GitHub web UI on 2026-10-17, so its subject has no type. It
	// is published, so it cannot be rewritten, and the commit-lint check lints every
	// commit in a merge's range — which means any branch that merges `main` fails on
	// a commit it did not author. Exempt that one subject rather than weaken the
	// check for the commits a pull request actually writes. (Measured 2026-11-02 over
	// `main`..`rewrite/main`: this is the only commit in the range that fails.)
	ignores: [(message) => message.split('\n')[0].trim() === 'Create CODE_OF_CONDUCT.md'],
	rules: {
		'body-max-line-length': [0, 'always'],
		'header-max-length': [0, 'always'],
		'subject-case': [0, 'always'],
		'header-case': [0, 'always'],
		'body-case': [0, 'always'],
		'footer-max-line-length': [0, 'always'],
  },
}
