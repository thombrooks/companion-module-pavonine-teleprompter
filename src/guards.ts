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

/**
 * The current TLS-PSK bridge uses Apple's Network framework and is packaged as
 * a universal macOS native addon. Unkeyed Teleprompter connections use Node's
 * TCP socket and remain portable.
 */
export function keyedTransportUnsupportedMessage(platform = process.platform, arch = process.arch): string | undefined {
	if (platform !== 'darwin')
		return 'Network-key-protected Teleprompter connections are currently supported only on macOS. Unkeyed connections remain available.'
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
): string | undefined {
	if (!differentKey) return undefined
	return keyedTransportUnsupportedMessage(platform, arch) ? 'Network Key - Unsupported' : 'Different Network Key'
}

/** Explain why protected documents cannot be listed when the keyed bridge is unavailable. */
export function protectedDocumentUnavailableMessage(
	differentKey: boolean,
	platform = process.platform,
	arch = process.arch,
): string | undefined {
	if (!differentKey || !keyedTransportUnsupportedMessage(platform, arch)) return undefined
	return 'Network Key - Unsupported — protected documents require macOS'
}
