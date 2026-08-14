export interface FrameDecodeResult {
	frames: Buffer[]
	remainder: Buffer
	impossibleLength: boolean
}

/** Consume complete Teleprompter length-prefixed frames without losing a partial tail. */
export function decodeFrames(buffer: Buffer): FrameDecodeResult {
	const frames: Buffer[] = []
	let offset = 0
	while (buffer.length - offset >= 8) {
		const length = buffer.readBigUInt64LE(offset)
		if (length > BigInt(Number.MAX_SAFE_INTEGER)) return { frames, remainder: Buffer.alloc(0), impossibleLength: true }
		const end = offset + 8 + Number(length)
		if (end > buffer.length) break
		frames.push(buffer.subarray(offset + 8, end))
		offset = end
	}
	return { frames, remainder: buffer.subarray(offset), impossibleLength: false }
}
