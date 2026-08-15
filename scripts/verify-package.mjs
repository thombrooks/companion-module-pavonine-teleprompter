import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const archive = process.argv[2]
if (!archive) throw new Error('Usage: node scripts/verify-package.mjs <package.tgz>')

const expectedFiles = [
	'prebuilds/teleprompter-tls-addon-darwin-arm64/node-napi-v10.node',
	'prebuilds/teleprompter-tls-addon-darwin-x64/libteleprompter_tls_native.dylib',
	'prebuilds/teleprompter-tls-addon-darwin-x64/node-napi-v10.node',
	'prebuilds/teleprompter-tls-addon-linux-arm64/node-napi-v10.node',
	'prebuilds/teleprompter-tls-addon-linux-x64/node-napi-v10.node',
	'prebuilds/teleprompter-tls-addon-win32-arm64/node-napi-v10.node',
	'prebuilds/teleprompter-tls-addon-win32-x64/node-napi-v10.node',
]

const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)
	.map((file) => file.replace(/^[^/]+\//, ''))
	.filter((file) => file.startsWith('prebuilds/'))
	.filter((file) => file.endsWith('.node') || file.endsWith('.dylib'))
	.sort()

assert.deepEqual(files, expectedFiles)
console.log(`Verified ${archive}`)