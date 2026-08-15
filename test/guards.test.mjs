import assert from 'node:assert/strict'
import test from 'node:test'

import {
	keyedConnectionLog,
	keyedTransportUnsupportedMessage,
	maySendTransport,
	noKeyDeviceRequiresKeyClear,
	networkKeyDeviceLabelPrefix,
	protectedDocumentUnavailableMessage,
	stopResetPress,
} from '../dist/guards.js'

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

test('keyed transport is enabled only when the current package contains its prebuild', () => {
	assert.equal(keyedTransportUnsupportedMessage('darwin', 'arm64'), undefined)
	assert.equal(keyedTransportUnsupportedMessage('darwin', 'x64'), undefined)
	assert.equal(keyedTransportUnsupportedMessage('win32', 'x64', true), undefined)
	assert.equal(keyedTransportUnsupportedMessage('linux', 'arm64', true), undefined)
	assert.match(keyedTransportUnsupportedMessage('win32', 'x64'), /not bundled for win32\/x64/)
	assert.match(keyedTransportUnsupportedMessage('linux', 'arm64'), /not bundled for linux\/arm64/)
	assert.match(keyedTransportUnsupportedMessage('darwin', 'arm'), /Apple Silicon or Intel/)
})

test('a no-key device asks to clear a key only when Companion has one saved', () => {
	assert.equal(noKeyDeviceRequiresKeyClear('', 'device', 'device'), false)
	assert.equal(noKeyDeviceRequiresKeyClear('FOOBAR', 'device', 'device'), true)
	assert.equal(noKeyDeviceRequiresKeyClear('FOOBAR', 'device', 'different-key'), false)
})

test('keyed-device labels distinguish a mismatch from an unsupported platform', () => {
	assert.equal(networkKeyDeviceLabelPrefix(false, 'win32', 'arm64'), undefined)
	assert.equal(networkKeyDeviceLabelPrefix(true, 'darwin', 'arm64'), 'Different Network Key')
	assert.equal(networkKeyDeviceLabelPrefix(true, 'win32', 'arm64'), 'Network Key - Unsupported')
	assert.equal(networkKeyDeviceLabelPrefix(true, 'win32', 'arm64', true), 'Different Network Key')
	assert.equal(networkKeyDeviceLabelPrefix(true, 'linux', 'x64'), 'Network Key - Unsupported')
})

test('protected document picker explains unsupported keyed transport without claiming a mismatch', () => {
	assert.equal(protectedDocumentUnavailableMessage(false, 'win32', 'arm64'), undefined)
	assert.equal(protectedDocumentUnavailableMessage(true, 'darwin', 'arm64'), undefined)
	assert.equal(
		protectedDocumentUnavailableMessage(true, 'win32', 'arm64'),
		'Network Key - Unsupported — protected documents require a bundled native transport',
	)
	assert.equal(protectedDocumentUnavailableMessage(true, 'win32', 'arm64', true), undefined)
})

test('Stop & Reset requires a second press while confirmation is pending', () => {
	assert.equal(stopResetPress(false), 'confirm')
	assert.equal(stopResetPress(true), 'reset')
})
