import { createHash, pbkdf2Sync } from 'node:crypto'
import net from 'node:net'

import type { Motion, TimingState } from './protocol.js'

export function addressPreference(address: string): number {
	if (net.isIP(address) === 4) return 0
	if (net.isIP(address) === 6 && !address.toLowerCase().startsWith('fe80:')) return 1
	return 2
}

export function preferredHosts(addresses: string[], localAddresses: ReadonlySet<string>): string[] {
	const unique = [...new Set(addresses)]
	if (unique.some((address) => localAddresses.has(address))) return [...new Set(['::1', '127.0.0.1', ...unique])]
	return unique.sort((a, b) => addressPreference(a) - addressPreference(b))
}

export function networkKeyChallenge(networkKey: string, deviceId: string): string {
	const material = pbkdf2Sync(networkKey.trim(), deviceId, 4096, 32, 'sha256')
	return createHash('sha256').update(material).digest('base64')
}

export function hasDifferentNetworkKey(networkKey: string, deviceId: string, challenge: string | undefined): boolean {
	if (!challenge) return false
	const key = networkKey.trim()
	return key ? challenge !== networkKeyChallenge(key, deviceId) : challenge !== deviceId
}

export function clampManualSpeed(speed: number): number {
	return Math.max(0, Math.min(500, speed))
}

export function speedLabel(speed: number): string {
	return `${Math.round(clampManualSpeed(speed) / 5)}%`
}

export function selectedDocumentAfterDeviceChange(
	previousDeviceId: string,
	nextDeviceId: string,
	documentId: string,
): string {
	return previousDeviceId === nextDeviceId ? documentId : ''
}

export function automaticallySelectedDocument(
	documents: ReadonlyMap<string, string>,
	selectedDocumentId: string,
): string | undefined {
	if (selectedDocumentId || documents.size !== 1) return undefined
	return documents.keys().next().value
}

/** A selected document is safe for position-dependent control only after its own timing snapshot arrives. */
export function hasFreshDocumentTimingSnapshot(documentId: string, snapshots: ReadonlyMap<string, number>): boolean {
	return Boolean(documentId) && snapshots.has(documentId)
}

/** Short, operator-facing state for a Stream Deck document-status indicator. */
export function documentStatus(
	connected: boolean,
	documents: ReadonlyMap<string, string>,
	selectedDocumentId: string,
	selectedDocumentName: string,
): string {
	if (!connected) return 'OFFLINE'
	const selectedName = documents.get(selectedDocumentId)
	if (selectedName) return `READY\n${selectedName}`
	if (!selectedDocumentId) return 'NO DOCUMENT\nSELECTED'
	return `CLOSED\n${selectedDocumentName || 'DOCUMENT'}`
}

export function estimateTiming(
	timing: TimingState,
	motion: Motion,
	speed: number,
	startedAt: number | undefined,
	now: number,
): TimingState {
	if (motion === 'stopped' || startedAt === undefined) return timing
	const direction = motion === 'reverse' ? -1 : 1
	return { ...timing, keyPosition: Math.max(0, timing.keyPosition + direction * ((now - startedAt) / 1000) * speed) }
}
