import assert from 'node:assert/strict'
import test from 'node:test'

import { frame, resetMutation, segmentJumpMutation, selectorMutation, speedMutation, transportMutation } from '../dist/protocol.js'

const documentId = '01234567-89AB-CDEF-0123-456789ABCDEF'

function decode(buffer) {
	assert.equal(buffer.readBigInt64LE(0), BigInt(buffer.length - 8), 'frame length prefix matches payload length')
	return JSON.parse(buffer.subarray(8).toString('utf8'))
}

function changes(buffer) {
	return decode(buffer)[2].map(([path, operation]) => ({
		path,
		value: operation[1][0],
		clock: operation[1][1],
	}))
}

function changedValue(changeSet, leaf) {
	return changeSet.find(({ path }) => path.at(-1) === leaf)?.value
}

function rawClocks(buffer) {
	return [...buffer.subarray(8).toString('utf8').matchAll(/"index":\["\+",([^\]]+)\],"ammendment":\["\+",([^\]]+)\]/g)]
		.map((match) => ({ index: match[1], amendment: match[2] }))
}

test('frame writes a signed, little-endian Int64 payload length', () => {
	const message = frame('hé')
	assert.equal(message.readBigInt64LE(0), 3n)
	assert.equal(message.subarray(8).toString('utf8'), 'hé')
})

test('forward transport atomically carries the current keypoint, zero keyTime, and motion', () => {
	const changeSet = changes(transportMutation(documentId, 'forward', { keyPosition: 123.5, keyTime: 0 }, 101n))
	assert.deepEqual(changedValue(changeSet, 'keyPosition'), [2, ['CGFloat', 123.5]])
	assert.deepEqual(changedValue(changeSet, 'keyTime'), [2, ['Delta', 0]])
	assert.deepEqual(changedValue(changeSet, 'motion'), [2, ['Timing.Motion', 'forward']])
	assert.equal(changedValue(changeSet, 'scrolledPosition'), undefined)
	assert.equal(changedValue(changeSet, 'timerStart'), undefined)
})

test('the first forward play after reset starts the show timer in the same transaction', () => {
	const changeSet = changes(transportMutation(documentId, 'forward', { keyPosition: 0, keyTime: 0 }, 102n, true))
	assert.deepEqual(changedValue(changeSet, 'timerStart'), [2, ['Delta', 0]])
})

test('pause atomically makes the evaluated position the paused visible position', () => {
	const changeSet = changes(transportMutation(documentId, 'stopped', { keyPosition: 456, keyTime: 0 }, 103n))
	assert.deepEqual(changedValue(changeSet, 'keyPosition'), [2, ['CGFloat', 456]])
	assert.deepEqual(changedValue(changeSet, 'keyTime'), [2, ['Delta', 0]])
	assert.deepEqual(changedValue(changeSet, 'scrolledPosition'), [2, ['CGFloat', 456]])
	assert.deepEqual(changedValue(changeSet, 'motion'), [1])
})

test('speed mutation atomically establishes a keypoint before changing manualSpeed', () => {
	const changeSet = changes(speedMutation(documentId, 110, { keyPosition: 99, keyTime: 0 }, 104n))
	assert.deepEqual(changeSet.map((change) => change.path.at(-1)), ['keyPosition', 'keyTime', 'manualSpeed'])
	assert.deepEqual(changedValue(changeSet, 'keyPosition'), [2, ['CGFloat', 99]])
	assert.deepEqual(changedValue(changeSet, 'keyTime'), [2, ['Delta', 0]])
	assert.deepEqual(changedValue(changeSet, 'manualSpeed'), [2, ['Double', 110]])
})

test('selector mutation selects manual or automatic marker timing directly', () => {
	assert.deepEqual(changedValue(changes(selectorMutation(documentId, 'manual', 105n)), 'selector'), [2, ['Timing.Selector', 'manual']])
	assert.deepEqual(changedValue(changes(selectorMutation(documentId, 'timed', 106n)), 'selector'), [2, ['Timing.Selector', 'timed']])
})

test('segment jump is an anchored paused-position write with zero keyTime', () => {
	const changeSet = changes(segmentJumpMutation(documentId, 100, 500, 106n))
	assert.deepEqual(changeSet.map((change) => change.path.at(-1)), ['keyPosition', 'keyTime', 'scrolledPosition'])
	assert.deepEqual(changeSet[0].value, [2, ['CGFloat', 100]])
	assert.deepEqual(changeSet[1].value, [2, ['Delta', 0]])
	assert.deepEqual(changeSet[2].value, [2, ['CGFloat', 500]])
})

test('reset stops, resets the visible position, and clears the elapsed timer', () => {
	const changeSet = changes(resetMutation(documentId, 105n))
	assert.deepEqual(changedValue(changeSet, 'motion'), [1])
	assert.deepEqual(changedValue(changeSet, 'scrolledPosition'), [2, ['CGFloat', 0]])
	assert.deepEqual(changedValue(changeSet, 'timerStart'), [1])
})

test('one message shares its index while operations use zero then distinct random amendments', () => {
	const clocks = rawClocks(resetMutation(documentId, 999n))
	assert.equal(clocks.length, 3)
	assert.ok(clocks.every((clock) => clock.index === '999'))
	assert.equal(clocks[0].amendment, '0')
	assert.notEqual(clocks[1].amendment, '0')
	assert.notEqual(clocks[2].amendment, '0')
	assert.notEqual(clocks[1].amendment, clocks[2].amendment)
})
