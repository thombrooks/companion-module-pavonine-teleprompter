import assert from 'node:assert/strict'
import test from 'node:test'

import { keyedConnectionLog, maySendTransport } from '../dist/guards.js'

test('transport is blocked until a selected document has a fresh snapshot', () => {
	assert.equal(maySendTransport(false, 'document'), false)
	assert.equal(maySendTransport(true, ''), false)
	assert.equal(maySendTransport(true, 'document'), true)
})

test('keyed connection diagnostics disclose only key presence', () => {
	const message = keyedConnectionLog('192.168.1.14', 65400, true)
	assert.match(message, /network key present: yes/)
	assert.doesNotMatch(message, /FOOBAR|[0-9a-f]{32}/i)
})
