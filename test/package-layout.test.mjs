import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

test('the distributable runtime files required for keyed transport are present', () => {
	for (const file of [
		'companion/manifest.json',
		'prebuilds/teleprompter-tls-addon-darwin-arm64/node-napi-v10.node',
		'prebuilds/teleprompter-tls-addon-darwin-x64/node-napi-v10.node',
		'prebuilds/teleprompter-tls-addon-darwin-x64/libteleprompter_tls_native.dylib',
		'prebuilds/teleprompter-tls-addon-linux-arm64/node-napi-v10.node',
		'prebuilds/teleprompter-tls-addon-linux-x64/node-napi-v10.node',
		'prebuilds/teleprompter-tls-addon-win32-arm64/node-napi-v10.node',
		'prebuilds/teleprompter-tls-addon-win32-x64/node-napi-v10.node',
	])
		assert.equal(existsSync(path.join(root, file)), true, `${file} must be bundled`)
	const manifest = JSON.parse(readFileSync(path.join(root, 'companion/manifest.json'), 'utf8'))
	assert.equal(manifest.runtime.type, 'node22')
	assert.equal(manifest.runtime.permissions['native-addons'], true)
})

test('the local native prebuild loads through stable N-API', { skip: process.platform !== 'darwin' }, () => {
	const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined
	if (!architecture) return
	const addon = require(path.join(root, `prebuilds/teleprompter-tls-addon-darwin-${architecture}/node-napi-v10.node`))
	assert.equal(typeof addon.start, 'function')
	assert.equal(typeof addon.send, 'function')
})

test('the native addon build uses pinned stable N-API headers under Node 22', () => {
	const buildScript = readFileSync(path.join(root, 'scripts/build-tls-addon.sh'), 'utf8')
	const portableBuild = readFileSync(path.join(root, 'native/CMakeLists.txt'), 'utf8')
	const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
	assert.match(buildScript, /node scripts\/require-node22\.mjs/)
	assert.match(buildScript, /node-api-headers\/include\/node_api\.h/)
	assert.match(buildScript, /swiftc -target x86_64-apple-macos11/)
	assert.match(buildScript, /clang\+\+ -target x86_64-apple-macos11/)
	assert.match(portableBuild, /third_party\/mbedtls/)
	assert.match(portableBuild, /-ffile-prefix-map=/)
	assert.match(portableBuild, /\/experimental:deterministic/)
	assert.match(portableBuild, /\/pathmap:/)
	assert.match(buildScript, /-S "\$project_dir\/native"/)
	assert.match(buildScript, /-DNODE_API_INCLUDE/)
	assert.match(buildScript, /--target teleprompter_tls_addon/)
	assert.match(buildScript, /-DPython3_EXECUTABLE/)
	assert.match(buildScript, /CLANG_MODULE_CACHE_PATH/)
	assert.match(buildScript, /-file-prefix-map "\$project_dir=\."/)
	assert.match(buildScript, /-ffile-prefix-map="\$project_dir=\."/)
	assert.match(buildScript, /build_dir_relative/)
	assert.match(buildScript, /--baseDir "\$build_dir_relative\/arm64"/)
	assert.match(buildScript, /--baseDir "\$build_dir_relative\/x86_64"/)
	assert.doesNotMatch(buildScript, /--baseDir "\$build_dir\//)
	assert.match(buildScript, /-install_name -Xlinker @rpath\/libteleprompter_tls_native\.dylib/)
	assert.match(buildScript, /pkg-prebuilds-copy/)
	assert.match(buildScript, /--napi_version 10/)
	assert.doesNotMatch(buildScript, /rm -rf prebuilds\n/)
	assert.match(buildScript, /teleprompter-tls-addon-darwin-arm64/)
	assert.match(buildScript, /--platform darwin --arch arm64/)
	assert.doesNotMatch(buildScript, /Cellar\/node|\/opt\/homebrew/)
	assert.equal(packageJson.devDependencies['node-api-headers'], '1.9.0')
})
