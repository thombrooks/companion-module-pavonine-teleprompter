/** A transport mutation is safe only after the selected document has a fresh snapshot. */
export function maySendTransport(snapshotAvailable: boolean, documentId: string): boolean {
	return snapshotAvailable && documentId.length > 0
}

/** Keep secret values out of diagnostic strings. */
export function keyedConnectionLog(host: string, port: number, keyPresent: boolean): string {
	return `Connecting to ${host}:${port}; network key present: ${keyPresent ? 'yes' : 'no'}`
}
