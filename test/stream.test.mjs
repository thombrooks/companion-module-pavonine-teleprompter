import assert from 'node:assert/strict'
import test from 'node:test'

import { frame } from '../dist/protocol.js'
import { decodeFrames } from '../dist/stream.js'

test('reassembles one frame split across arbitrary TCP chunks', () => {
	const complete = frame('{"documents":[]}')
	const first = decodeFrames(complete.subarray(0, 11))
	assert.deepEqual(first.frames, [])
	assert.equal(first.remainder.length, 11)
	const second = decodeFrames(Buffer.concat([first.remainder, complete.subarray(11)]))
	assert.equal(second.frames.length, 1)
	assert.equal(second.frames[0].toString(), '{"documents":[]}')
	assert.equal(second.remainder.length, 0)
})

test('consumes concatenated frames and ignores zero-length keepalives at the caller', () => {
	const combined = Buffer.concat([frame('one'), frame(''), frame('two')])
	const result = decodeFrames(combined)
	assert.deepEqual(result.frames.map((value) => value.toString()), ['one', '', 'two'])
	assert.equal(result.remainder.length, 0)
})

test('keeps an incomplete trailing frame for the next TCP chunk', () => {
	const first = frame('complete')
	const second = frame('partial')
	const result = decodeFrames(Buffer.concat([first, second.subarray(0, 10)]))
	assert.deepEqual(result.frames.map((value) => value.toString()), ['complete'])
	assert.deepEqual(result.remainder, second.subarray(0, 10))
})

test('rejects an impossible frame length without retaining unsafe buffered data', () => {
	const header = Buffer.alloc(8)
	header.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
	const result = decodeFrames(header)
	assert.equal(result.impossibleLength, true)
	assert.equal(result.remainder.length, 0)
})
