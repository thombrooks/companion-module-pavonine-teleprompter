import assert from 'node:assert/strict'
import test from 'node:test'

import { frame, resetMutation, segmentJumpMutation, speedMutation, transportMutation } from '../dist/protocol.js'

const documentId = '01234567-89AB-CDEF-0123-456789ABCDEF'

function decode(buffer) {
	assert.equal(buffer.readBigUInt64LE(0), BigInt(buffer.length - 8), 'frame length prefix matches payload length')
	return JSON.parse(buffer.subarray(8).toString('utf8'))
}

function changes(buffer) {
	return decode(buffer)[2].map(([path, operation]) => ({
		path,
		value: operation[1][0],
	}))
}

function changedValue(changeSet, leaf) {
	return changeSet.find(({ path }) => path.at(-1) === leaf)?.value
}

test('frame writes an unsigned, little-endian 64-bit payload length', () => {
	const message = frame('hé')
	assert.equal(message.readBigUInt64LE(0), 3n)
	assert.equal(message.subarray(8).toString('utf8'), 'hé')
})

test('forward transport atomically carries the current anchor and motion', () => {
	const changeSet = changes(transportMutation(documentId, 'forward', { keyPosition: 123.5, keyTime: 9 }, 101n, false))
	assert.deepEqual(changedValue(changeSet, 'keyPosition'), [2, ['CGFloat', 123.5]])
	assert.deepEqual(changedValue(changeSet, 'keyTime'), [2, ['Delta', 9]])
	assert.deepEqual(changedValue(changeSet, 'motion'), [2, ['Timing.Motion', 'forward']])
	assert.equal(changedValue(changeSet, 'scrolledPosition'), undefined)
	assert.equal(changedValue(changeSet, 'timerStart'), undefined)
})

test('first forward transport after reset starts the elapsed-time timer', () => {
	const changeSet = changes(transportMutation(documentId, 'forward', { keyPosition: 0, keyTime: 0.002 }, 102n, true))
	assert.deepEqual(changedValue(changeSet, 'timerStart'), [2, ['Delta', 0.002]])
})

test('pause preserves both the key and visible scroll position', () => {
	const changeSet = changes(transportMutation(documentId, 'stopped', { keyPosition: 456, keyTime: 0.002 }, 103n, false))
	assert.deepEqual(changedValue(changeSet, 'keyPosition'), [2, ['CGFloat', 456]])
	assert.deepEqual(changedValue(changeSet, 'keyTime'), [2, ['Delta', 0.002]])
	assert.deepEqual(changedValue(changeSet, 'scrolledPosition'), [2, ['CGFloat', 456]])
	assert.deepEqual(changedValue(changeSet, 'motion'), [1])
})

test('speed mutation changes only manualSpeed', () => {
	const changeSet = changes(speedMutation(documentId, 110, 104n))
	assert.equal(changeSet.length, 1)
	assert.deepEqual(changeSet[0].path, ['documents', documentId, 'model', 'timing', 'manualSpeed'])
	assert.deepEqual(changeSet[0].value, [2, ['Double', 110]])
})

test('segment jump keeps the current anchor and moves only the visible playhead', () => {
	const changeSet = changes(segmentJumpMutation(documentId, 100, 500, 106n))
	assert.deepEqual(changeSet.map((change) => change.path.at(-1)), ['keyPosition', 'keyTime', 'scrolledPosition'])
	assert.deepEqual(changeSet[0].value, [2, ['CGFloat', 100]])
	assert.deepEqual(changeSet[2].value, [2, ['CGFloat', 500]])
})

test('reset stops and moves the visible position to the start', () => {
	const changeSet = changes(resetMutation(documentId, 105n))
	assert.deepEqual(changedValue(changeSet, 'motion'), [1])
	assert.deepEqual(changedValue(changeSet, 'scrolledPosition'), [2, ['CGFloat', 0]])
})
