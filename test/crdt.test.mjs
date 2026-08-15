import assert from 'node:assert/strict'
import test from 'node:test'

import { deltaFromWire, deltaToWire, maximumObservedIndex, parseTreeMessage, removedDocumentId } from '../dist/crdt.js'

test('document-root unset removes only the closed document', () => {
	assert.equal(removedDocumentId(['documents', 'doc-a'], [1]), 'doc-a')
	assert.equal(removedDocumentId(['documents', 'doc-a'], [[1], { index: ['+', 1, 2] }]), 'doc-a')
})

test('document fields and normal CRDT writes do not remove a document', () => {
	assert.equal(removedDocumentId(['documents', 'doc-a', 'name'], [1]), undefined)
	assert.equal(removedDocumentId(['documents', 'doc-a'], [2, ['String', 'Script.tp3']]), undefined)
})

test('Delta clock limbs form one big-endian arbitrary-precision value', () => {
	const value = deltaFromWire(['+', '885', '747008163878722339'])
	assert.equal(value, 885n * (2n ** 64n) + 747008163878722339n)
	assert.deepEqual(deltaToWire(value), ['+', '885', '747008163878722339'])
})

test('maximum observed index compares whole Delta values anywhere in an incoming tree message', () => {
	const message = [
		'FRESH-MESSAGE-UUID',
		false,
		[
			[['documents', 'doc', 'model', 'timing', 'motion'], [1, [[1], { index: ['+', 4, 9] }], false]],
			[['documents', 'doc', 'model', 'timing', 'manualSpeed'], [1, [[1], { index: ['+', 5, 1] }], false]],
		],
		0,
	]
	assert.equal(maximumObservedIndex(message), 5n * (2n ** 64n) + 1n)
})

test('TreeMessage parsing retains decimal UInt64 limbs without Number rounding', () => {
	const message = parseTreeMessage('{"index":["+",885,747008163878722339]}')
	assert.equal(maximumObservedIndex(message), 885n * (2n ** 64n) + 747008163878722339n)
})
