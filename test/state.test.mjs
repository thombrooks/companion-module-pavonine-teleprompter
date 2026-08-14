import assert from 'node:assert/strict'
import test from 'node:test'

import {
	addressPreference,
	clampManualSpeed,
	documentStatus,
	estimateTiming,
	hasDifferentNetworkKey,
	hasFreshDocumentTimingSnapshot,
	networkKeyChallenge,
	preferredHosts,
	speedLabel,
} from '../dist/state.js'

test('discovery prefers IPv4, then global IPv6, then unusable link-local IPv6', () => {
	assert.deepEqual(preferredHosts(['fe80::1', '2001:db8::1', '192.168.1.14'], new Set()), [
		'192.168.1.14',
		'2001:db8::1',
		'fe80::1',
	])
	assert.equal(addressPreference('fe80::1'), 2)
})

test('a local multi-NIC service uses loopback before advertised addresses', () => {
	assert.deepEqual(preferredHosts(['192.168.1.10', '10.0.0.10'], new Set(['10.0.0.10'])), [
		'::1',
		'127.0.0.1',
		'192.168.1.10',
		'10.0.0.10',
	])
})

test('network-key challenge accepts only the matching key and never needs the key after derivation', () => {
	const id = 'DD1185D4-9F65-4D18-946D-9084FA3080C5'
	const challenge = networkKeyChallenge('FOOBAR', id)
	assert.equal(hasDifferentNetworkKey('FOOBAR', id, challenge), false)
	assert.equal(hasDifferentNetworkKey('wrong', id, challenge), true)
	assert.equal(hasDifferentNetworkKey('', id, id), false)
	assert.equal(hasDifferentNetworkKey('', id, challenge), true)
})

test('speed adjustments and display values clamp at the Teleprompter range', () => {
	assert.equal(clampManualSpeed(-1), 0)
	assert.equal(clampManualSpeed(501), 500)
	assert.equal(speedLabel(110), '22%')
	assert.equal(speedLabel(999), '100%')
})

test('document status distinguishes connection, discovery, and a live selected document', () => {
	const documents = new Map([['doc-a', 'Script.tp3']])
	assert.equal(documentStatus(false, documents, 'doc-a', 'Script.tp3'), 'OFFLINE')
	assert.equal(documentStatus(true, new Map(), '', ''), 'NO DOCUMENT\nSELECTED')
	assert.equal(documentStatus(true, documents, '', ''), 'NO DOCUMENT\nSELECTED')
	assert.equal(documentStatus(true, documents, 'doc-a', 'Script.tp3'), 'READY\nScript.tp3')
	assert.equal(documentStatus(true, new Map(), 'doc-a', 'Script.tp3'), 'CLOSED\nScript.tp3')
})

test('a document must receive its own timing snapshot before position-dependent control is safe', () => {
	const snapshots = new Map([['other-document', Date.now()]])
	assert.equal(hasFreshDocumentTimingSnapshot('', snapshots), false)
	assert.equal(hasFreshDocumentTimingSnapshot('selected-document', snapshots), false)
	snapshots.set('selected-document', Date.now())
	assert.equal(hasFreshDocumentTimingSnapshot('selected-document', snapshots), true)
})

test('estimated playhead preserves a middle position for pause and direction switching', () => {
	assert.deepEqual(estimateTiming({ keyPosition: 500, keyTime: 0.002 }, 'forward', 100, 1_000, 3_500), {
		keyPosition: 750,
		keyTime: 0.002,
	})
	assert.deepEqual(estimateTiming({ keyPosition: 500, keyTime: 0.002 }, 'reverse', 100, 1_000, 3_500), {
		keyPosition: 250,
		keyTime: 0.002,
	})
	assert.deepEqual(estimateTiming({ keyPosition: 50, keyTime: 0.002 }, 'reverse', 100, 1_000, 3_500), {
		keyPosition: 0,
		keyTime: 0.002,
	})
})
