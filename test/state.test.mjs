import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync } from 'node:crypto'
import test from 'node:test'

import {
	addressPreference,
	clampManualSpeed,
	documentStatus,
	evaluateTiming,
	hasDifferentNetworkKey,
	hasFreshDocumentTimingSnapshot,
	networkKeyChallenge,
	preferredHosts,
	segmentButtonState,
	speedLabel,
} from '../dist/state.js'

test('numbered segment button feedback has exactly four visual states', () => {
	assert.equal(segmentButtonState('stopped', true), 'active-paused')
	assert.equal(segmentButtonState('forward', true), 'active-moving')
	assert.equal(segmentButtonState('reverse', true), 'active-moving')
	assert.equal(segmentButtonState('stopped', false), 'inactive-paused')
	assert.equal(segmentButtonState('forward', false), 'inactive-moving')
	assert.equal(segmentButtonState('reverse', false), 'inactive-moving')
})

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

test('network-key challenge accepts only the matching key and reproduces the app non-ASCII byte-length quirk', () => {
	const id = 'DD1185D4-9F65-4D18-946D-9084FA3080C5'
	const challenge = networkKeyChallenge('FOOBAR', id)
	assert.equal(hasDifferentNetworkKey('FOOBAR', id, challenge), false)
	assert.equal(hasDifferentNetworkKey('wrong', id, challenge), true)
	assert.equal(hasDifferentNetworkKey('', id, id), false)
	assert.equal(hasDifferentNetworkKey('', id, challenge), true)
	const appPasswordBytes = Buffer.from('café', 'utf8').subarray(0, [...'café'].length)
	const expected = createHash('sha256').update(pbkdf2Sync(appPasswordBytes, id, 4096, 32, 'sha256')).digest('base64')
	assert.equal(networkKeyChallenge('café', id), expected)
	assert.notEqual(networkKeyChallenge('café', id), networkKeyChallenge('cafe', id))
})

test('speed adjustments clamp at zero and at the document maximumSpeed when known', () => {
	assert.equal(clampManualSpeed(-1), 0)
	assert.equal(clampManualSpeed(501), 501)
	assert.equal(clampManualSpeed(501, 250), 250)
	assert.equal(speedLabel(110), '22%')
	assert.equal(speedLabel(999, 250), '50%')
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

test('timing evaluator uses keyTime only while moving and scrolledPosition only while paused', () => {
	const state = { keyPosition: 500, keyTime: 2, scrolledPosition: 111, maximumPosition: 2000 }
	assert.equal(evaluateTiming(state, 'forward', 100, 10_000), 1700)
	assert.equal(evaluateTiming(state, 'reverse', 100, 10_000), 0)
	assert.equal(evaluateTiming(state, 'stopped', 100, 10_000), 111)
})

test('timing evaluator clamps the protocol-derived position without inventing a local start time', () => {
	assert.equal(
		evaluateTiming({ keyPosition: 500, keyTime: 0, scrolledPosition: 20, maximumPosition: 1000 }, 'forward', 100, 2_500),
		750,
	)
	assert.equal(
		evaluateTiming({ keyPosition: 500, keyTime: 0, scrolledPosition: 20, maximumPosition: 600 }, 'forward', 100, 2_500),
		600,
	)
})
