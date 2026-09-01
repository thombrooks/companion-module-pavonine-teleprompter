import assert from 'node:assert/strict'
import test from 'node:test'

import {
	automaticallySelectedDocument,
	networkKeyChallenge,
	restoredDeviceId,
	selectedDocumentAfterDeviceChange,
} from '../dist/state.js'

test('changing Teleprompter device clears a previously selected document', () => {
	assert.equal(selectedDocumentAfterDeviceChange('mac', 'ipad', 'document-a'), '')
	assert.equal(selectedDocumentAfterDeviceChange('mac', 'mac', 'document-a'), 'document-a')
})

test('only one discovered document is auto-selected without overwriting a user choice', () => {
	const one = new Map([['document-a', 'Script.tp3']])
	assert.equal(automaticallySelectedDocument(one, ''), 'document-a')
	assert.equal(automaticallySelectedDocument(one, 'document-a'), undefined)
	assert.equal(automaticallySelectedDocument(new Map(), ''), undefined)
	assert.equal(
		automaticallySelectedDocument(
			new Map([
				['a', 'A'],
				['b', 'B'],
			]),
			'',
		),
		undefined,
	)
})

test('a restarted Teleprompter is restored by its friendly name only when the network key is compatible', () => {
	const id = 'DD1185D4-9F65-4D18-946D-9084FA3080C5'
	const replacement = 'DD1185D4-9F65-4D18-946D-9084FA3080C6'
	const devices = [{ id: replacement, name: 'iPad', challenge: networkKeyChallenge('FOOBAR', replacement) }]
	assert.equal(restoredDeviceId(id, 'iPad', 'FOOBAR', devices), replacement)
	assert.equal(restoredDeviceId(id, 'iPad', 'wrong', devices), undefined)
	assert.equal(restoredDeviceId(id, 'Different iPad', 'FOOBAR', devices), undefined)
	assert.equal(restoredDeviceId(id, 'iPad', 'FOOBAR', [...devices, { id: 'other', name: 'iPad' }]), undefined)
})

test('an unkeyed Teleprompter is restored by its friendly name after its service UUID changes', () => {
	const id = 'DD1185D4-9F65-4D18-946D-9084FA3080C5'
	const replacement = 'DD1185D4-9F65-4D18-946D-9084FA3080C6'
	assert.equal(
		restoredDeviceId(id, 'iPad', '', [{ id: replacement, name: 'iPad', challenge: replacement }]),
		replacement,
	)
	assert.equal(
		restoredDeviceId(id, 'iPad', 'stored-key', [{ id: replacement, name: 'iPad', challenge: replacement }]),
		replacement,
	)
	assert.equal(
		restoredDeviceId(id, 'iPad', '', [{ id: replacement, name: 'iPad', challenge: 'different-key' }]),
		undefined,
	)
})
