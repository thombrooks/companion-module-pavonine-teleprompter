import { randomBytes, randomUUID } from 'node:crypto'

export type Motion = 'forward' | 'reverse' | 'stopped'

export interface TimingState {
	keyPosition: number
	/** Seconds elapsed between the local timing keypoint and serialization. */
	keyTime: number
	scrolledPosition?: number
	maximumPosition?: number
	/** Local receipt time, used to reconstruct the sender's keypoint. */
	receivedAt?: number
}

/** Frame a UTF-8 TreeMessage with Teleprompter's signed Int64 LE length header. */
export function frame(payload: string): Buffer {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.alloc(8)
	header.writeBigInt64LE(BigInt(body.length))
	return Buffer.concat([header, body])
}

function randomUInt64(): bigint {
	let value = randomBytes(8).readBigUInt64LE()
	// The amendment after the first operation must be a fresh random64, not zero.
	if (value === 0n) value = 1n
	return value
}

function delta(value: bigint): string {
	if (value < 0n) throw new Error('Teleprompter mutation clocks must be non-negative')
	const limbs: string[] = []
	let remaining = value
	do {
		limbs.unshift((remaining & ((1n << 64n) - 1n)).toString())
		remaining >>= 64n
	} while (remaining > 0n)
	return `["+",${limbs.join(',')}]`
}

function mutation(documentId: string, changes: Array<[string[], unknown]>, index: bigint): string {
	const messageUuid = randomUUID().toUpperCase()
	const changesJson = changes
		.map(([path, value], operation) => {
			const amendment = operation === 0 ? 0n : randomUInt64()
			return `[${JSON.stringify(['documents', documentId, 'model', ...path])},[1,[${JSON.stringify(value)},{"index":${delta(index)},"ammendment":${delta(amendment)}}],false]]`
		})
		.join(',')
	return `["${messageUuid}",false,[${changesJson}],0]`
}

function keypointChanges(timing: TimingState): Array<[string[], unknown]> {
	return [
		[['timing', 'keyPosition'], [2, ['CGFloat', timing.keyPosition]]],
		[['timing', 'keyTime'], [2, ['Delta', 0]]],
	]
}

/** Every transport change establishes a fresh keypoint in the same TreeMessage. */
export function transportMutation(
	documentId: string,
	motion: Motion,
	timing: TimingState,
	index: bigint,
	startTimer = false,
): Buffer {
	const changes = keypointChanges(timing)
	if (motion === 'stopped') {
		changes.push([['timing', 'scrolledPosition'], [2, ['CGFloat', timing.keyPosition]]])
		changes.push([['timing', 'motion'], [1]])
	} else {
		changes.push([['timing', 'motion'], [2, ['Timing.Motion', motion]]])
		if (motion === 'forward' && startTimer) changes.push([['timerInfo', 'timerStart'], [2, ['Delta', 0]]])
	}
	return frame(mutation(documentId, changes, index))
}

/** A speed write without a keypoint retroactively changes elapsed movement. */
export function speedMutation(documentId: string, speed: number, timing: TimingState, index: bigint): Buffer {
	return frame(mutation(documentId, [...keypointChanges(timing), [['timing', 'manualSpeed'], [2, ['Double', speed]]]], index))
}

/** Select Teleprompter's manual-speed or automatic marker-timing mode. */
export function selectorMutation(documentId: string, selector: 'manual' | 'timed', index: bigint): Buffer {
	return frame(mutation(documentId, [[['timing', 'selector'], [2, ['Timing.Selector', selector]]]], index))
}

/** Segment navigation writes paused scroll state and is only issued while paused. */
export function segmentJumpMutation(documentId: string, currentPosition: number, targetPosition: number, index: bigint): Buffer {
	return frame(
		mutation(
			documentId,
			[
				[['timing', 'keyPosition'], [2, ['CGFloat', currentPosition]]],
				[['timing', 'keyTime'], [2, ['Delta', 0]]],
				[['timing', 'scrolledPosition'], [2, ['CGFloat', targetPosition]]],
			],
			index,
		),
	)
}

export function resetMutation(documentId: string, index: bigint): Buffer {
	return frame(
		mutation(
			documentId,
			[
				[['timing', 'motion'], [1]],
				[['timing', 'scrolledPosition'], [2, ['CGFloat', 0]]],
				[['timerInfo', 'timerStart'], [1]],
			],
			index,
		),
	)
}
