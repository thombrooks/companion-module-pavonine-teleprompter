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

test('silently skips zero-length keepalives and continues reading the following frame', () => {
	const combined = Buffer.concat([frame('one'), frame(''), frame('two')])
	const result = decodeFrames(combined)
	assert.deepEqual(result.frames.map((value) => value.toString()), ['one', 'two'])
	assert.equal(result.remainder.length, 0)
})

test('keeps an incomplete trailing frame for the next TCP chunk', () => {
	const first = frame('complete')
	const second = frame('partial')
	const result = decodeFrames(Buffer.concat([first, second.subarray(0, 10)]))
	assert.deepEqual(result.frames.map((value) => value.toString()), ['complete'])
	assert.deepEqual(result.remainder, second.subarray(0, 10))
})

test('silently skips an invalid signed or oversized header and re-reads the next header', () => {
	const negative = Buffer.alloc(8)
	negative.writeBigInt64LE(-1n)
	const oversized = Buffer.alloc(8)
	oversized.writeBigInt64LE(2n ** 32n)
	const result = decodeFrames(Buffer.concat([negative, oversized, frame('after')]))
	assert.deepEqual(result.frames.map((value) => value.toString()), ['after'])
	assert.equal(result.impossibleLength, false)
	assert.equal(result.remainder.length, 0)
})

test('retains an incomplete valid frame after invalid headers were skipped', () => {
	const header = Buffer.alloc(8)
	header.writeBigInt64LE(10n)
	const result = decodeFrames(Buffer.concat([Buffer.alloc(8), header, Buffer.from('abc')]))
	assert.equal(result.impossibleLength, false)
	assert.deepEqual(result.remainder, Buffer.concat([header, Buffer.from('abc')]))
})
