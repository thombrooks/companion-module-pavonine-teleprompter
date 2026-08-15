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
		const length = buffer.readBigInt64LE(offset)
		// Teleprompter treats zero as a keepalive and silently discards invalid
		// signed/oversized headers before reading the next header.
		if (length <= 0n || length >= 2n ** 32n) {
			offset += 8
			continue
		}
		const end = offset + 8 + Number(length)
		if (end > buffer.length) break
		frames.push(buffer.subarray(offset + 8, end))
		offset = end
	}
	return { frames, remainder: buffer.subarray(offset), impossibleLength: false }
}
