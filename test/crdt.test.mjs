import assert from 'node:assert/strict'
import test from 'node:test'

import { removedDocumentId } from '../dist/crdt.js'

test('document-root unset removes only the closed document', () => {
	assert.equal(removedDocumentId(['documents', 'doc-a'], [1]), 'doc-a')
	assert.equal(removedDocumentId(['documents', 'doc-a'], [[1], { index: ['+', 1, 2] }]), 'doc-a')
})

test('document fields and normal CRDT writes do not remove a document', () => {
	assert.equal(removedDocumentId(['documents', 'doc-a', 'name'], [1]), undefined)
	assert.equal(removedDocumentId(['documents', 'doc-a'], [2, ['String', 'Script.tp3']]), undefined)
})
