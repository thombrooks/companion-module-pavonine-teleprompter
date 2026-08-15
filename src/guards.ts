/** A transport mutation is safe only after the selected document has a fresh snapshot. */
export function maySendTransport(snapshotAvailable: boolean, documentId: string): boolean {
	return snapshotAvailable && documentId.length > 0
}

/** The first Stop & Reset press asks for confirmation; only the second executes it. */
export function stopResetPress(pendingConfirmation: boolean): 'confirm' | 'reset' {
	return pendingConfirmation ? 'reset' : 'confirm'
}

/** Keep secret values out of diagnostic strings. */
export function keyedConnectionLog(host: string, port: number, keyPresent: boolean): string {
	return `Connecting to ${host}:${port}; network key present: ${keyPresent ? 'yes' : 'no'}`
}

/** A keyed connection is enabled only when this package actually contains its native prebuild. */
export function keyedTransportUnsupportedMessage(
	platform = process.platform,
	arch = process.arch,
	prebuildAvailable = platform === 'darwin' && (arch === 'arm64' || arch === 'x64'),
): string | undefined {
	if (prebuildAvailable) return undefined
	if (platform !== 'darwin')
		return `Network-key-protected Teleprompter connections are not bundled for ${platform}/${arch}. Unkeyed connections remain available.`
	if (arch !== 'arm64' && arch !== 'x64')
		return `Network-key-protected Teleprompter connections require macOS on Apple Silicon or Intel (detected ${arch}).`
	return undefined
}

/** A no-key device needs the user to clear a key only when Companion has one saved. */
export function noKeyDeviceRequiresKeyClear(
	networkKey: string,
	deviceId: string,
	challenge: string | undefined,
): boolean {
	return networkKey.trim().length > 0 && challenge === deviceId
}

/** Make a keyed-device mismatch actionable on platforms which cannot use the keyed bridge. */
export function networkKeyDeviceLabelPrefix(
	differentKey: boolean,
	platform = process.platform,
	arch = process.arch,
	prebuildAvailable?: boolean,
): string | undefined {
	if (!differentKey) return undefined
	return keyedTransportUnsupportedMessage(platform, arch, prebuildAvailable) ? 'Network Key - Unsupported' : 'Different Network Key'
}

/** Explain why protected documents cannot be listed when the keyed bridge is unavailable. */
export function protectedDocumentUnavailableMessage(
	differentKey: boolean,
	platform = process.platform,
	arch = process.arch,
	prebuildAvailable?: boolean,
): string | undefined {
	if (!differentKey || !keyedTransportUnsupportedMessage(platform, arch, prebuildAvailable)) return undefined
	return 'Network Key - Unsupported — protected documents require a bundled native transport'
}
