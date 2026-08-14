import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('the distributable runtime files required for keyed transport are present', () => {
	for (const file of ['companion/manifest.json', 'companion/teleprompter-tls-addon.node', 'companion/libteleprompter_tls_native.dylib'])
		assert.equal(existsSync(path.join(root, file)), true, `${file} must be bundled`)
	const manifest = JSON.parse(readFileSync(path.join(root, 'companion/manifest.json'), 'utf8'))
	assert.equal(manifest.runtime.type, 'node22')
	assert.equal(manifest.runtime.permissions['native-addons'], true)
})
