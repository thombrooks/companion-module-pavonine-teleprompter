import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('the distributable runtime files required for keyed transport are present', () => {
	for (const file of [
		'companion/manifest.json',
		'companion/teleprompter-tls-addon.node',
		'companion/libteleprompter_tls_native.dylib',
	])
		assert.equal(existsSync(path.join(root, file)), true, `${file} must be bundled`)
	const manifest = JSON.parse(readFileSync(path.join(root, 'companion/manifest.json'), 'utf8'))
	assert.equal(manifest.runtime.type, 'node22')
	assert.equal(manifest.runtime.permissions['native-addons'], true)
})

test('the native addon build uses pinned stable N-API headers under Node 22', () => {
	const buildScript = readFileSync(path.join(root, 'scripts/build-tls-addon.sh'), 'utf8')
	const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
	assert.match(buildScript, /node scripts\/require-node22\.mjs/)
	assert.match(buildScript, /node-api-headers\/include\/node_api\.h/)
	assert.match(buildScript, /swiftc -target arm64-apple-macos11/)
	assert.match(buildScript, /swiftc -target x86_64-apple-macos11/)
	assert.match(buildScript, /clang\+\+ -target arm64-apple-macos11/)
	assert.match(buildScript, /clang\+\+ -target x86_64-apple-macos11/)
	assert.match(buildScript, /lipo -create/)
	assert.doesNotMatch(buildScript, /Cellar\/node|\/opt\/homebrew/)
	assert.equal(packageJson.devDependencies['node-api-headers'], '1.9.0')
})
