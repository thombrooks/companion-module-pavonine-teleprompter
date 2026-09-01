import { createHash, pbkdf2Sync } from 'node:crypto'
import net from 'node:net'

import type { Motion, TimingState } from './protocol.js'

/**
 * Four mutually exclusive visual states for a numbered segment button.
 * Keep this separate from command availability: it is purely operator feedback.
 */
export type SegmentButtonState = 'active-moving' | 'active-paused' | 'inactive-moving' | 'inactive-paused'

export function segmentButtonState(motion: Motion, isActive: boolean): SegmentButtonState {
	if (isActive) return motion === 'stopped' ? 'active-paused' : 'active-moving'
	return motion === 'stopped' ? 'inactive-paused' : 'inactive-moving'
}

/** Choose the next paused navigation position, including document start/end fallbacks. */
export function adjacentSegmentPosition(
	segmentPositions: readonly number[],
	position: number,
	maximumPosition: number | undefined,
	direction: -1 | 1,
): number | undefined {
	if (direction === -1) {
		if (position <= 0) return undefined
		const activeIndex = segmentPositions.reduce<number | undefined>(
			(current, segmentPosition, index) => (segmentPosition <= position ? index : current),
			undefined,
		)
		if (activeIndex === undefined) return 0
		if (position > segmentPositions[activeIndex]) return segmentPositions[activeIndex]
		return activeIndex > 0 ? segmentPositions[activeIndex - 1] : 0
	}
	const activeIndex = segmentPositions.reduce<number | undefined>(
		(current, segmentPosition, index) => (segmentPosition <= position ? index : current),
		undefined,
	)
	const nextIndex = activeIndex === undefined ? 0 : activeIndex + 1
	if (nextIndex < segmentPositions.length) return segmentPositions[nextIndex]
	return maximumPosition !== undefined && position < maximumPosition ? maximumPosition : undefined
}

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

export function networkKeyMaterial(networkKey: string, deviceId: string): Buffer {
	const key = networkKey.trim()
	// Teleprompter currently passes a grapheme count where PBKDF2 expects a UTF-8
	// byte length. Reproduce that interoperability quirk exactly.
	const password = Buffer.from(key, 'utf8').subarray(0, [...key].length)
	return pbkdf2Sync(password, deviceId, 4096, 32, 'sha256')
}

export function networkKeyChallenge(networkKey: string, deviceId: string): string {
	return createHash('sha256').update(networkKeyMaterial(networkKey, deviceId)).digest('base64')
}

export function hasDifferentNetworkKey(networkKey: string, deviceId: string, challenge: string | undefined): boolean {
	if (!challenge) return false
	const key = networkKey.trim()
	return key ? challenge !== networkKeyChallenge(key, deviceId) : challenge !== deviceId
}

/** Restore a restarted Teleprompter by its persisted friendly name and matching network key. */
export function restoredDeviceId(
	previousId: string,
	previousName: string,
	networkKey: string,
	devices: ReadonlyArray<{ id: string; name: string; challenge?: string }>,
): string | undefined {
	if (!previousId || !previousName) return undefined
	const matches = devices.filter(
		(device) =>
			device.name === previousName &&
			(device.challenge === device.id || !hasDifferentNetworkKey(networkKey, device.id, device.challenge)),
	)
	return matches.length === 1 ? matches[0].id : undefined
}

export function clampManualSpeed(speed: number, maximumSpeed?: number): number {
	const upper = typeof maximumSpeed === 'number' && Number.isFinite(maximumSpeed) ? maximumSpeed : Infinity
	return Math.max(0, Math.min(upper, speed))
}

export function speedLabel(speed: number, maximumSpeed?: number): string {
	return `${Math.round(clampManualSpeed(speed, maximumSpeed) / 5)}%`
}

/** Teleprompter's Total timer combines elapsed show time with remaining script time. */
export function showTimerTotal(elapsed: number, remaining: number): number {
	return Math.max(0, elapsed + remaining)
}

/** Manual-mode elapsed time starts at the script's first scheduled time. */
export function manualShowElapsed(
	timerStart: { elapsed: number; receivedAt: number } | undefined,
	scriptStartTime: number | undefined,
	now: number,
): number {
	const liveElapsed = timerStart ? timerStart.elapsed + (now - timerStart.receivedAt) / 1000 : 0
	return (scriptStartTime ?? 0) + liveElapsed
}

/** Timed playback uses the marker schedule itself, rather than the show clock. */
export function timedShowTimerValues(
	scheduled: number,
	scheduledTotal: number,
): { elapsed: number; remaining: number; total: number; aheadBehind: number } {
	return {
		elapsed: scheduled,
		remaining: Math.max(0, scheduledTotal - scheduled),
		total: scheduledTotal,
		aheadBehind: 0,
	}
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

/** Evaluate Teleprompter's own timing state; do not invent a local playback clock. */
export function evaluateTiming(timing: TimingState, motion: Motion, speed: number, now: number): number {
	const maximum = timing.maximumPosition ?? Infinity
	if (motion === 'stopped') return Math.max(0, Math.min(maximum, timing.scrolledPosition ?? timing.keyPosition))
	const receivedAt = timing.receivedAt ?? 0
	const elapsedSeconds = timing.keyTime + (now - receivedAt) / 1000
	const direction = motion === 'reverse' ? -1 : 1
	return Math.max(0, Math.min(maximum, timing.keyPosition + direction * elapsedSeconds * speed))
}
