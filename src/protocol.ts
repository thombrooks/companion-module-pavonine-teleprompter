import { randomBytes, randomUUID } from 'node:crypto'

export type Motion = 'forward' | 'reverse' | 'stopped'

/**
 * Wire format observed in Teleprompter 3.1.1: an unsigned 64-bit little-endian
 * byte length, followed by a UTF-8 JSON CollaborativeKit TreeMessage.
 */
export function frame(payload: string): Buffer {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.alloc(8)
	header.writeBigUInt64LE(BigInt(body.length))
	return Buffer.concat([header, body])
}

function randomUInt64(): string {
	return randomBytes(8).readBigUInt64LE().toString()
}

function mutation(documentId: string, changes: Array<[string[], unknown]>, sequence: bigint): string {
	const actor = randomUUID().toUpperCase()
	const index = randomUInt64()
	// JSON.stringify cannot preserve the 64-bit CRDT clock values. They are emitted
	// as decimal JSON integer literals, matching CollaborativeKit's Swift encoder.
	const changesJson = changes
		.map(([path, value]) => {
			const amendment = randomUInt64()
			return `[${JSON.stringify(['documents', documentId, 'model', ...path])},[1,[${JSON.stringify(value)},{"index":["+",${sequence.toString()},${index}],"ammendment":["+",${amendment}]}],false]]`
		})
		.join(',')
	return `["${actor}",false,[${changesJson}],0]`
}

export interface TimingState {
	keyPosition: number
	keyTime: number
}

/**
 * TP Controller changes transport with one atomic CRDT operation. Sending only
 * `motion` omits its anchor time/position and can make the host jump to EOF.
 */
export function transportMutation(
	documentId: string,
	motion: Motion,
	timing: TimingState,
	sequence: bigint,
	startTimer: boolean,
): Buffer {
	const timingBase = ['timing']
	const position: [string[], unknown] = [[...timingBase, 'keyPosition'], [2, ['CGFloat', timing.keyPosition]]]
	const keyTime: [string[], unknown] = [[...timingBase, 'keyTime'], [2, ['Delta', timing.keyTime]]]
	if (motion === 'stopped') {
		// TP Controller includes the current position and visible scroll position
		// in its pause transaction; this preserves the point reached while playing.
		return frame(
			mutation(
				documentId,
				[
					position,
					keyTime,
					[[...timingBase, 'scrolledPosition'], [2, ['CGFloat', timing.keyPosition]]],
					[[...timingBase, 'motion'], [1]],
				],
				sequence,
			),
		)
	}
	const changes: Array<[string[], unknown]> = [
		position,
		keyTime,
		[[...timingBase, 'motion'], [2, ['Timing.Motion', motion]]],
	]
	// TP Controller starts the elapsed-time timer after Stop & Reset, but does
	// not restart it when resuming from an ordinary pause.
	if (startTimer) changes.push([['timerInfo', 'timerStart'], [2, ['Delta', 0.002]]])
	return frame(mutation(documentId, changes, sequence))
}

export function speedMutation(documentId: string, speed: number, sequence: bigint): Buffer {
	return frame(mutation(documentId, [[['timing', 'manualSpeed'], [2, ['Double', speed]]]], sequence))
}

export function resetMutation(documentId: string, sequence: bigint): Buffer {
	const actor = randomUUID().toUpperCase()
	const index = randomUInt64()
	const amendment = randomUInt64()
	const position = JSON.stringify(['CGFloat', 0])
	const stopped = JSON.stringify([1])
	const base = ['documents', documentId, 'model', 'timing']
	return frame(
		`["${actor}",false,[[${JSON.stringify([...base, 'motion'])},[1,[${stopped},{"index":["+",${sequence.toString()},${index}],"ammendment":["+",${amendment}]}],false]],[${JSON.stringify([...base, 'scrolledPosition'])},[1,[[2,${position}],{"index":["+",${sequence.toString()},${index}],"ammendment":["+",${amendment}]}],false]]],0]`,
	)
}
