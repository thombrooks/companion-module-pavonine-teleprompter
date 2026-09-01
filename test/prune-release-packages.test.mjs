import assert from 'node:assert/strict'
import test from 'node:test'

import { releaseArchivesToDelete } from '../scripts/prune-release-packages.mjs'

test('release retention keeps the current package and one previous stable package', () => {
	const archives = [
		'pavonine-teleprompter-0.8.0-alpha.5.tgz',
		'pavonine-teleprompter-0.8.0.tgz',
		'pavonine-teleprompter-0.8.14.tgz',
		'pavonine-teleprompter-0.8.15.tgz',
		'not-a-release.tgz',
	]
	assert.deepEqual(releaseArchivesToDelete(archives), [
		'pavonine-teleprompter-0.8.0.tgz',
		'pavonine-teleprompter-0.8.0-alpha.5.tgz',
	])
})
