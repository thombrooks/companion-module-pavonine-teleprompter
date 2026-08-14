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
