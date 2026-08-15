/** Returns a document ID only for a CRDT unset of a document-map entry. */
export function removedDocumentId(path: unknown, value: unknown): string | undefined {
	if (!Array.isArray(path) || path.length !== 2 || path[0] !== 'documents' || typeof path[1] !== 'string') return undefined
	return isUnsetValue(value) ? path[1] : undefined
}

export function isUnsetValue(value: unknown): boolean {
	if (!Array.isArray(value)) return false
	if (value.length === 1 && value[0] === 1) return true
	return value.some(isUnsetValue)
}

const LIMB_BITS = 64n
const LIMB_MASK = (1n << LIMB_BITS) - 1n

/** Decode CollaborativeKit's signed, big-endian UInt64-limb Delta. */
export function deltaFromWire(value: unknown): bigint | undefined {
	if (!Array.isArray(value) || (value[0] !== '+' && value[0] !== '-')) return undefined
	let result = 0n
	for (const limb of value.slice(1)) {
		let parsed: bigint
		if (typeof limb === 'string' && /^\d+$/.test(limb)) parsed = BigInt(limb)
		else if (typeof limb === 'number' && Number.isSafeInteger(limb) && limb >= 0) parsed = BigInt(limb)
		else return undefined
		if (parsed > LIMB_MASK) return undefined
		result = (result << LIMB_BITS) + parsed
	}
	return value[0] === '-' ? -result : result
}

/** Encode a non-negative Delta as decimal limbs without IEEE-754 rounding. */
export function deltaToWire(value: bigint): ['+', ...string[]] {
	if (value < 0n) throw new Error('Only non-negative mutation clocks are supported')
	const limbs: string[] = []
	let remainder = value
	do {
		limbs.unshift((remainder & LIMB_MASK).toString())
		remainder >>= LIMB_BITS
	} while (remainder > 0n)
	return ['+', ...limbs]
}

/** Find the greatest full `index` Delta in any received TreeMessage value. */
export function maximumObservedIndex(value: unknown): bigint | undefined {
	let maximum: bigint | undefined
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child)
			return
		}
		if (!node || typeof node !== 'object') return
		const record = node as Record<string, unknown>
		const index = deltaFromWire(record.index)
		if (index !== undefined && (maximum === undefined || index > maximum)) maximum = index
		for (const child of Object.values(record)) visit(child)
	}
	visit(value)
	return maximum
}

/**
 * Parse a TreeMessage without losing UInt64 Delta limbs to JavaScript Number
 * rounding. Only numbers inside a syntactically complete `["+", …]` / `["-", …]`
 * array are converted to decimal strings before JSON parsing.
 */
export function parseTreeMessage(json: string): unknown {
	let normalized = ''
	let cursor = 0
	while (cursor < json.length) {
		const opener = /\[\s*"[+-]"\s*,/g
		opener.lastIndex = cursor
		const match = opener.exec(json)
		if (!match) {
			normalized += json.slice(cursor)
			break
		}
		const start = match.index
		normalized += json.slice(cursor, start)
		let end = start
		let depth = 0
		let inString = false
		let escaped = false
		for (; end < json.length; end += 1) {
			const character = json[end]
			if (inString) {
				if (escaped) escaped = false
				else if (character === '\\') escaped = true
				else if (character === '"') inString = false
				continue
			}
			if (character === '"') inString = true
			else if (character === '[') depth += 1
			else if (character === ']') {
				depth -= 1
				if (depth === 0) {
					end += 1
					break
				}
			}
		}
		const candidate = json.slice(start, end)
		if (/^\[\s*"[+-]"\s*(?:,\s*\d+\s*)+\]$/.test(candidate))
			normalized += candidate.replace(/,(\s*)(\d+)/g, (_match, whitespace: string, digits: string) =>
				`,${whitespace}"${digits}"`,
			)
		else normalized += candidate
		cursor = end
	}
	return JSON.parse(normalized)
}
