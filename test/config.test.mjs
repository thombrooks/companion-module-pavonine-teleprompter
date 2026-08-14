import assert from 'node:assert/strict'
import test from 'node:test'

import { automaticallySelectedDocument, selectedDocumentAfterDeviceChange } from '../dist/state.js'

test('changing Teleprompter device clears a previously selected document', () => {
	assert.equal(selectedDocumentAfterDeviceChange('mac', 'ipad', 'document-a'), '')
	assert.equal(selectedDocumentAfterDeviceChange('mac', 'mac', 'document-a'), 'document-a')
})

test('only one discovered document is auto-selected without overwriting a user choice', () => {
	const one = new Map([['document-a', 'Script.tp3']])
	assert.equal(automaticallySelectedDocument(one, ''), 'document-a')
	assert.equal(automaticallySelectedDocument(one, 'document-a'), undefined)
	assert.equal(automaticallySelectedDocument(new Map(), ''), undefined)
	assert.equal(automaticallySelectedDocument(new Map([['a', 'A'], ['b', 'B']]), ''), undefined)
})
