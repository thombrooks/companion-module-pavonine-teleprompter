import {
	InstanceBase,
	InstanceStatus,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
	type SomeCompanionConfigField,
	type CompanionVariableDefinitions,
} from '@companion-module/base'
import Bonjour, { type Browser, type Service } from 'bonjour-service'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import {
	resetMutation,
	segmentJumpMutation,
	selectorMutation,
	speedMutation,
	transportMutation,
	type Motion,
	type TimingState,
} from './protocol.js'
import {
	automaticallySelectedDocument,
	clampManualSpeed,
	documentStatus,
	evaluateTiming,
	hasDifferentNetworkKey,
	hasFreshDocumentTimingSnapshot,
	networkKeyMaterial,
	preferredHosts,
	selectedDocumentAfterDeviceChange,
	segmentButtonState,
	speedLabel,
} from './state.js'
import { decodeFrames } from './stream.js'
import {
	keyedConnectionLog,
	keyedTransportUnsupportedMessage,
	maySendTransport,
	noKeyDeviceRequiresKeyClear,
	networkKeyDeviceLabelPrefix,
	protectedDocumentUnavailableMessage,
	stopResetPress,
} from './guards.js'
import { isUnsetValue, maximumObservedIndex, parseTreeMessage, removedDocumentId } from './crdt.js'
const nodeRequire = createRequire(import.meta.url)
const nativeBindingOptions = { name: 'teleprompter-tls-addon', napi_versions: [10] }
type NativeTlsAddon = {
	start(
		host: string,
		port: string,
		psk: Buffer,
		ready: () => void,
		data: (data: Buffer) => void,
		error: (message: string) => void,
	): unknown
	send(connection: unknown, data: Buffer): void
}

function loadNativeTlsAddon(moduleDirectory: string): NativeTlsAddon {
	const baseDirectory = existsSync(path.join(moduleDirectory, 'prebuilds'))
		? moduleDirectory
		: path.dirname(moduleDirectory)
	const loadPrebuild = nodeRequire('pkg-prebuilds') as (
		base: string,
		options: typeof nativeBindingOptions,
	) => NativeTlsAddon
	return loadPrebuild(baseDirectory, nativeBindingOptions)
}

interface Config {
	[key: string]: string | number | boolean | null
	deviceId: string
	/** Friendly identity persisted across per-launch Bonjour instance UUID changes. */
	deviceName: string
	manual: boolean
	host: string
	port: number
	documentId: string
	documentName: string
}
interface Secrets {
	[key: string]: string | number | boolean | null
	networkKey: string
}
type ActionSchema = {
	play: { options: Record<string, never> }
	pause: { options: Record<string, never> }
	reverse: { options: Record<string, never> }
	stop_reset: { options: Record<string, never> }
	set_speed: { options: { speed: number } }
	speed_up_5: { options: Record<string, never> }
	speed_up_1: { options: Record<string, never> }
	speed_down_5: { options: Record<string, never> }
	speed_down_1: { options: Record<string, never> }
	select_manual_mode: { options: Record<string, never> }
	select_auto_mode: { options: Record<string, never> }
	toggle_play_pause: { options: Record<string, never> }
	jump_segment: { options: { index: number } }
	previous_segment: { options: Record<string, never> }
	next_segment: { options: Record<string, never> }
}
type FeedbackSchema = {
	is_playing: { type: 'boolean'; options: Record<string, never> }
	is_reverse_playing: { type: 'boolean'; options: Record<string, never> }
	is_document_ready: { type: 'boolean'; options: Record<string, never> }
	is_manual_playback_mode: { type: 'boolean'; options: Record<string, never> }
	is_auto_playback_mode: { type: 'boolean'; options: Record<string, never> }
	is_manual_speed_unavailable: { type: 'boolean'; options: Record<string, never> }
	timer_ahead_behind: { type: 'advanced'; options: Record<string, never> }
	stop_reset_confirmation: { type: 'advanced'; options: Record<string, never> }
	is_segment_active: { type: 'boolean'; options: { index: number } }
	is_segment_active_moving: { type: 'boolean'; options: { index: number } }
	is_segment_unavailable: { type: 'boolean'; options: { index: number } }
	segment_button_style: { type: 'advanced'; options: { index: number } }
	segment_display: { type: 'advanced'; options: { index: number } }
	segment_navigation_display: { type: 'advanced'; options: { direction: 'previous' | 'next' } }
}
type VariableSchema = {
	playback_state: string
	scroll_speed: string
	playback_mode: string
	document_status: string
	current_segment: string
	timer_elapsed: string
	timer_remaining: string
	timer_total: string
	timer_ahead_behind: string
}
type ModuleSchema = {
	config: Config
	secrets: Secrets
	actions: ActionSchema
	feedbacks: FeedbackSchema
	variables: VariableSchema
}
interface Endpoint {
	host: string
	port: number
}
interface TeleprompterDevice extends Endpoint {
	id: string
	name: string
	challenge?: string
	/** All resolved Bonjour addresses, in connection preference order. */
	hosts: string[]
}
interface Segment {
	index: number
	id: string
	name: string
	position: number
	pauseEnabled: boolean
	pauseDuration: number
}

function formatDuration(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds))
	const hours = Math.floor(whole / 3600)
	const minutes = Math.floor((whole % 3600) / 60)
	const remainingSeconds = whole % 60
	return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function interpolateTimerTime(
	points: ReadonlyArray<{ position: number; time: number }>,
	position: number,
): number | undefined {
	if (!points.length) return undefined
	if (position <= points[0].position) return points[0].time
	for (let index = 1; index < points.length; index++) {
		const right = points[index]
		const left = points[index - 1]
		if (position <= right.position) {
			const distance = right.position - left.position
			return distance > 0 ? left.time + ((position - left.position) / distance) * (right.time - left.time) : right.time
		}
	}
	return points.at(-1)?.time
}

export default class TeleprompterInstance extends InstanceBase<ModuleSchema> {
	private config: Config = {
		deviceId: '',
		deviceName: '',
		manual: false,
		host: '',
		port: 65330,
		documentId: '',
		documentName: '',
	}
	private secrets: Secrets = { networkKey: '' }
	/** Greatest full CollaborativeKit index observed on the wire this session. */
	private maximumIndex = 0n
	private socket: net.Socket | undefined
	private bridge: unknown
	private keyedDataReceived = false
	private receiveBuffer = Buffer.alloc(0)
	private reconnectTimer: NodeJS.Timeout | undefined
	private noDocumentTimer: NodeJS.Timeout | undefined
	private documentRefreshTimer: NodeJS.Timeout | undefined
	private stopResetConfirmationTimer: NodeJS.Timeout | undefined
	private stopResetFlashTimer: NodeJS.Timeout | undefined
	private stopResetConfirmationPending = false
	private stopResetFlashOn = false
	private discoveryRefreshTimer: NodeJS.Timeout | undefined
	private destroyed = false
	private bonjour: Bonjour | undefined
	private browser: Browser | undefined
	private readonly devices = new Map<string, TeleprompterDevice>()
	// Try every Bonjour address when a multi-interface Mac advertises one service.
	private keyedHostIndex = 0
	private readonly documents = new Map<string, string>()
	private readonly documentMotions = new Map<string, Motion>()
	private readonly documentTiming = new Map<string, TimingState>()
	/** Timestamp of the most recent complete timing snapshot for each document. */
	private readonly documentTimingSnapshots = new Map<string, number>()
	private readonly documentSpeeds = new Map<string, number>()
	private readonly documentMaximumSpeeds = new Map<string, number>()
	private readonly documentSelectors = new Map<string, 'manual' | 'timed'>()
	private readonly documentTimerStarts = new Map<string, { elapsed: number; receivedAt: number }>()
	private readonly documentTimingFunctions = new Map<string, Array<{ position: number; time: number }>>()
	private readonly documentSegments = new Map<string, Segment[]>()
	private segmentStatusTimer: NodeJS.Timeout | undefined
	private timerStatusTimer: NodeJS.Timeout | undefined
	private lastSegmentStatus: string | undefined
	private motion: Motion = 'stopped'
	private connectionActive = false

	public async init(config: Config, _isFirstInit: boolean, secrets: Secrets): Promise<void> {
		this.config = { ...config, deviceName: config.deviceName ?? '', documentName: config.documentName ?? '' }
		this.secrets = { networkKey: secrets?.networkKey ?? '' }
		this.setActionDefinitions(this.getActions())
		this.setFeedbackDefinitions(this.getFeedbacks())
		this.setVariableDefinitions(this.getVariables())
		this.setPresetDefinitions(this.getPresetStructure(), this.getPresets())
		this.setVariableValues({ scroll_speed: '—%' })
		this.setVariableValues({ playback_mode: '—' })
		this.setVariableValues({ current_segment: 'NO SEGMENTS' })
		this.setVariableValues({
			timer_elapsed: '0:00:00',
			timer_remaining: '—',
			timer_total: '—',
			timer_ahead_behind: '—',
		})
		this.timerStatusTimer = setInterval(() => this.refreshTimerStatus(), 250)
		this.updateDocumentStatus()
		this.setPlaybackState('stopped')
		this.startDiscovery()
		this.connect()
	}
	public async configUpdated(config: Config, secrets: Secrets): Promise<void> {
		const nextDeviceName = this.devices.get(config.deviceId)?.name ?? config.deviceName ?? ''
		const deviceChanged = nextDeviceName !== this.config.deviceName || config.manual !== this.config.manual
		const keyChanged = secrets?.networkKey !== this.secrets.networkKey
		const documentId = selectedDocumentAfterDeviceChange(this.config.deviceId, config.deviceId, config.documentId)
		const documentName = deviceChanged
			? ''
			: config.documentName ||
				(documentId === this.config.documentId ? this.config.documentName : (this.documents.get(documentId) ?? ''))
		this.config = { ...config, deviceName: nextDeviceName, documentId, documentName }
		this.secrets = { networkKey: secrets?.networkKey ?? '' }
		if (deviceChanged || keyChanged) this.keyedHostIndex = 0
		// Keep the monotonic session clock across connection/configuration changes.
		this.documents.clear()
		this.documentSegments.clear()
		this.documentTimingSnapshots.clear()
		this.updateSegmentStatus()
		this.updateDocumentStatus()
		this.setPlaybackState('stopped')
		if (deviceChanged) this.saveConfig(this.config)
		this.disconnect()
		this.connect()
		if (!keyChanged && !this.networkKey()) await this.refreshDocuments()
	}

	public getConfigFields(): SomeCompanionConfigField[] {
		const keyedTransportUnavailable = this.keyedTransportSupportMessage()
		const deviceChoices = [{ id: '', label: 'Searching for Teleprompters…' }]
		for (const device of [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name)))
			deviceChoices.push({ id: device.id, label: this.deviceLabel(device) })
		const selectedDevice = this.devices.get(this.config.deviceId)
		const protectedDocumentUnavailable = selectedDevice
			? protectedDocumentUnavailableMessage(
					this.hasDifferentKey(selectedDevice),
					process.platform,
					process.arch,
					this.nativeTlsAddonAvailable(),
				)
			: undefined
		const documentPlaceholder = protectedDocumentUnavailable
			? protectedDocumentUnavailable
			: selectedDevice && noKeyDeviceRequiresKeyClear(this.networkKey(), selectedDevice.id, selectedDevice.challenge)
				? 'No Network Key — clear the saved key above to control this device'
				: selectedDevice && this.hasDifferentKey(selectedDevice)
					? 'Different Network Key — enter the matching key above'
					: this.networkKey()
						? 'Connecting securely — documents will appear after authentication'
						: 'Discovering documents…'
		const documentChoices = [{ id: '', label: documentPlaceholder }]
		for (const [id, name] of [...this.documents.entries()].sort((a, b) => a[1].localeCompare(b[1])))
			documentChoices.push({ id, label: name })
		return [
			{
				type: 'static-text',
				id: 'discovery_help',
				label: 'Setup',
				width: 12,
				value:
					'Choose a Teleprompter device and click Save, then reopen this panel to choose its document. A device labelled “Different Network Key” cannot be controlled until its Teleprompter network key matches the protected key below. Companion never changes Teleprompter’s setting.',
			},
			{
				type: 'secret-text',
				id: 'networkKey',
				label: 'Network key (optional; hidden)',
				width: 12,
				default: '',
			},
			...(keyedTransportUnavailable
				? [
						{
							type: 'static-text' as const,
							id: 'keyed_transport_support',
							label: 'Network-key support',
							width: 12,
							value: keyedTransportUnavailable,
						},
					]
				: []),
			{
				type: 'dropdown',
				id: 'deviceId',
				label: 'Teleprompter device',
				width: 12,
				default: '',
				choices: deviceChoices,
				isVisibleExpression: '!$(options:manual)',
			},
			{ type: 'checkbox', id: 'manual', label: 'Configure manually', width: 12, default: false },
			{
				type: 'textinput',
				id: 'host',
				label: 'Manual host / IPv6 address',
				width: 8,
				default: '',
				isVisibleExpression: '$(options:manual)',
			},
			{
				type: 'number',
				id: 'port',
				label: 'Manual TCP port',
				width: 4,
				default: 65330,
				min: 1,
				max: 65535,
				isVisibleExpression: '$(options:manual)',
			},
			{
				type: 'dropdown',
				id: 'documentId',
				label: 'Document (after saving device)',
				width: 12,
				default: '',
				choices: documentChoices,
			},
		]
	}

	private startDiscovery(): void {
		if (this.bonjour) return
		try {
			this.bonjour = new Bonjour({}, (error: Error) => this.log('warn', `Bonjour error: ${error.message}`))
			this.browser = this.bonjour.find({ type: 'teleprompter3', protocol: 'tcp' }, (service) => this.addDevice(service))
			this.browser.on('txt-update', (service) => this.addDevice(service))
			this.browser.on('srv-update', (service) => this.addDevice(service))
			this.browser.on('down', (service) => this.removeDevice(service))
			this.discoveryRefreshTimer = setInterval(() => this.browser?.update(), 5000)
		} catch (error) {
			this.updateStatus(InstanceStatus.UnknownWarning, `Bonjour discovery unavailable: ${(error as Error).message}`)
		}
	}
	private addDevice(service: Service): void {
		const id = service.name
		const previous = this.devices.get(id)
		const advertised = (service.addresses ?? []).filter((address) => net.isIP(address) !== 0)
		const resolvedAddresses = [...new Set([...(previous?.hosts ?? []), ...advertised])]
		// Bonjour may deliver SRV/TXT before the A/AAAA response, especially for an
		// iPad waking onto Wi-Fi. Keep the service visible and let Network.framework
		// resolve its advertised .local host until its numeric address arrives.
		if (resolvedAddresses.length === 0 && service.host) resolvedAddresses.push(service.host)
		if (resolvedAddresses.length === 0 || !service.port) return
		const localAddresses = new Set(
			Object.values(networkInterfaces())
				.flat()
				.flatMap((entry) => (entry ? [entry.address] : [])),
		)
		// Bonjour resolves a local service through every active NIC. Loopback is
		// reliable and avoids guessing between Wi-Fi, Thunderbolt, and USB NICs.
		const hosts = preferredHosts(resolvedAddresses, localAddresses)
		const host = hosts[0]
		const txt = service.txt as Record<string, unknown> | undefined
		const name = this.txtString(txt?.hostname) ?? this.txtString(txt?.name) ?? previous?.name ?? service.name
		const challenge = this.txtString(txt?.challenge)
		this.devices.set(id, { id, name, host, hosts, port: service.port, challenge })
		if (!this.config.manual && !this.config.deviceId && this.devices.size === 1) {
			this.config = { ...this.config, deviceId: id, deviceName: name }
			this.saveConfig(this.config)
			this.log('info', `Automatically selected the only available Teleprompter: ${name}`)
			this.connect()
		} else if (!this.config.manual && this.config.deviceId === id && !this.socket) this.connect()
		else if (!this.config.manual && !this.devices.has(this.config.deviceId) && this.config.deviceName === name) {
			const matches = [...this.devices.values()].filter((candidate) => candidate.name === name)
			if (matches.length === 1) {
				this.config = { ...this.config, deviceId: id }
				this.log('info', `Restored Teleprompter selection after its service restarted: ${name}`)
				this.connect()
			}
		}
	}
	private removeDevice(service: Service): void {
		if (!this.devices.delete(service.name)) return
		this.log('info', `Teleprompter service went away: ${service.name}`)
		if (!this.config.manual && this.config.deviceId === service.name) {
			this.disconnect()
			this.updateStatus(InstanceStatus.Connecting, 'Waiting for Teleprompter to return')
		}
	}
	private networkKey(): string {
		return this.secrets.networkKey.trim()
	}
	/** Do not enable keyed control simply because the source code supports a platform. */
	private nativeTlsAddonAvailable(): boolean {
		const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
		const baseDirectory = existsSync(path.join(moduleDirectory, 'prebuilds')) ? moduleDirectory : path.dirname(moduleDirectory)
		return existsSync(
			path.join(
				baseDirectory,
				'prebuilds',
				`teleprompter-tls-addon-${process.platform}-${process.arch}`,
				'node-napi-v10.node',
			),
		)
	}
	private keyedTransportSupportMessage(): string | undefined {
		return keyedTransportUnsupportedMessage(process.platform, process.arch, this.nativeTlsAddonAvailable())
	}
	private deviceLabel(device: TeleprompterDevice): string {
		if (device.challenge === device.id) return `(No Network Key) ${device.name}`
		const prefix = networkKeyDeviceLabelPrefix(
			this.hasDifferentKey(device),
			process.platform,
			process.arch,
			this.nativeTlsAddonAvailable(),
		)
		return prefix ? `(${prefix}) ${device.name}` : device.name
	}
	private hasDifferentKey(device: TeleprompterDevice): boolean {
		return hasDifferentNetworkKey(this.networkKey(), device.id, device.challenge)
	}
	private txtString(value: unknown): string | undefined {
		if (typeof value === 'string') return value
		if (Buffer.isBuffer(value)) return value.toString('utf8')
		if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
		return undefined
	}

	private getActions(): CompanionActionDefinitions<ActionSchema> {
		const motion = (label: string, value: Motion) => ({
			name: label,
			options: [],
			callback: async () => this.runTransport(value),
		})
		return {
			play: motion('Play', 'forward'),
			pause: motion('Pause', 'stopped'),
			toggle_play_pause: {
				name: 'Play / Pause toggle',
				options: [],
				callback: async () => this.runTransport(this.motion === 'forward' ? 'stopped' : 'forward'),
			},
			reverse: {
				name: 'Reverse / Pause toggle',
				options: [],
				callback: async () => this.runTransport(this.motion === 'reverse' ? 'stopped' : 'reverse'),
			},
			stop_reset: {
				name: 'Stop and reset',
				options: [],
				callback: async () => this.requestStopReset(),
			},
			set_speed: {
				name: 'Set manual speed',
				options: [{ id: 'speed', type: 'number', label: 'Speed', default: 100, min: 0, max: 1000 }],
				callback: async (event) => this.setManualSpeed(Number(event.options.speed)),
			},
			speed_up_5: { name: 'Increase speed by 5%', options: [], callback: async () => this.adjustSpeed(5) },
			speed_up_1: { name: 'Increase speed by 1%', options: [], callback: async () => this.adjustSpeed(1) },
			speed_down_5: { name: 'Decrease speed by 5%', options: [], callback: async () => this.adjustSpeed(-5) },
			speed_down_1: { name: 'Decrease speed by 1%', options: [], callback: async () => this.adjustSpeed(-1) },
			select_manual_mode: {
				name: 'Select manual speed mode',
				options: [],
				callback: async () => this.setPlaybackMode('manual'),
			},
			select_auto_mode: {
				name: 'Select automatic speed mode',
				options: [],
				callback: async () => this.setPlaybackMode('timed'),
			},
			jump_segment: {
				name: 'Jump to segment',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				callback: async (event) => this.jumpToSegment(Number(event.options.index)),
			},
			previous_segment: { name: 'Previous segment', options: [], callback: async () => this.jumpAdjacentSegment(-1) },
			next_segment: { name: 'Next segment', options: [], callback: async () => this.jumpAdjacentSegment(1) },
		}
	}
	private getFeedbacks(): CompanionFeedbackDefinitions<FeedbackSchema> {
		return {
			is_playing: {
				type: 'boolean',
				name: 'Playing forward',
				description: 'True while the selected Teleprompter document is playing forward.',
				options: [],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff, text: 'PLAYING' },
				callback: () => this.motion === 'forward',
			},
			is_reverse_playing: {
				type: 'boolean',
				name: 'Playing in reverse',
				description: 'True while the selected Teleprompter document is playing in reverse.',
				options: [],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff, text: 'REV' },
				callback: () => this.motion === 'reverse',
			},
			is_document_ready: {
				type: 'boolean',
				name: 'Selected document is ready',
				description: 'True when connected and the selected document is currently advertised by Teleprompter.',
				options: [],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				callback: () =>
					this.connectionActive &&
					this.documents.has(this.config.documentId) &&
					this.hasSelectedDocumentTimingSnapshot(),
			},
			is_manual_playback_mode: {
				type: 'boolean',
				name: 'Manual speed mode selected',
				description: 'True when the selected document uses manually controlled speed.',
				options: [],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				callback: () => this.selectedPlaybackMode() === 'manual',
			},
			is_auto_playback_mode: {
				type: 'boolean',
				name: 'Automatic speed mode selected',
				description: 'True when the selected document uses marker-timed automatic playback.',
				options: [],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				callback: () => this.selectedPlaybackMode() === 'timed',
			},
			is_manual_speed_unavailable: {
				type: 'boolean',
				name: 'Manual speed controls unavailable',
				description: 'True in automatic mode, where Teleprompter ignores manual speed.',
				options: [],
				defaultStyle: { bgcolor: 0x505050, color: 0xaaaaaa },
				callback: () => this.selectedPlaybackMode() === 'timed',
			},
			timer_ahead_behind: {
				type: 'advanced',
				name: 'Ahead / Behind timer state',
				description: 'Shows live schedule variance: green ahead of schedule, red behind schedule.',
				options: [],
				callback: () => {
					const values = this.currentTimerValues()
					if (!values?.aheadBehind) return { text: 'Ahead\n—', size: '14', color: 0xffffff, bgcolor: 0x000000 }
					const ahead = values.aheadBehind >= 0
					return {
						text: `${ahead ? 'Ahead' : 'Behind'}\n${formatDuration(Math.abs(values.aheadBehind))}`,
						size: '14',
						color: 0xffffff,
						bgcolor: ahead ? 0x00aa00 : 0x8b0000,
					}
				},
			},
			stop_reset_confirmation: {
				type: 'advanced',
				name: 'Stop & Reset confirmation state',
				description: 'Flashes and asks for confirmation for three seconds after the first Stop & Reset press.',
				options: [],
				callback: () => ({
					text: this.stopResetConfirmationPending ? '◀ ■\nSURE?' : '◀ ■',
					size: this.stopResetConfirmationPending ? '18' : '24',
					color: 0xffffff,
					bgcolor: this.stopResetConfirmationPending && this.stopResetFlashOn ? 0x8b0000 : 0x000000,
				}),
			},
			is_segment_active: {
				type: 'boolean',
				name: 'Segment is active while paused',
				description: 'True when the selected document playhead is within this segment and is paused.',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				callback: (feedback) =>
					segmentButtonState(this.motion, this.activeSegment()?.index === Number(feedback.options.index)) ===
					'active-paused',
			},
			is_segment_active_moving: {
				type: 'boolean',
				name: 'Segment is active while moving',
				description: 'True when the selected document playhead is within this segment and is moving.',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0x006400, color: 0xffffff },
				callback: (feedback) =>
					segmentButtonState(this.motion, this.activeSegment()?.index === Number(feedback.options.index)) ===
					'active-moving',
			},
			is_segment_unavailable: {
				type: 'boolean',
				name: 'Inactive segment while moving',
				description: 'True when this segment is not current and Teleprompter is moving.',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				defaultStyle: { bgcolor: 0x505050, color: 0xaaaaaa },
				callback: (feedback) =>
					segmentButtonState(this.motion, this.activeSegment()?.index === Number(feedback.options.index)) ===
					'inactive-moving',
			},
			// One style feedback makes the precedence explicit: exactly one of the
			// four states is rendered for a numbered segment button.
			segment_button_style: {
				type: 'advanced',
				name: 'Numbered segment button state',
				description:
					'Current segment is bright green when paused and dark green while moving; other segments are black or gray.',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				callback: (feedback) => {
					const state = segmentButtonState(this.motion, this.activeSegment()?.index === Number(feedback.options.index))
					switch (state) {
						case 'active-paused':
							return { bgcolor: 0x00aa00, color: 0xffffff }
						case 'active-moving':
							return { bgcolor: 0x006400, color: 0xffffff }
						case 'inactive-moving':
							return { bgcolor: 0x505050, color: 0xaaaaaa }
						case 'inactive-paused':
							return { bgcolor: 0x000000, color: 0xffffff }
					}
				},
			},
			segment_display: {
				type: 'advanced',
				name: 'Segment label and active state',
				description: 'Shows the chosen segment number and name, and turns green while that segment is active.',
				options: [{ id: 'index', type: 'number', label: 'Segment number', default: 1, min: 1, max: 999 }],
				callback: (feedback) => {
					const index = Number(feedback.options.index)
					const segment = this.currentSegments().find((candidate) => candidate.index === index)
					return {
						text: segment ? `${segment.index}\n${segment.name}` : `SEGMENT\n${index}`,
						size: '14',
					}
				},
			},
			segment_navigation_display: {
				type: 'advanced',
				name: 'Segment navigation availability',
				description: 'Grays out next/previous segment controls while Teleprompter is moving.',
				options: [
					{
						id: 'direction',
						type: 'dropdown',
						label: 'Direction',
						default: 'next',
						choices: [
							{ id: 'previous', label: 'Previous segment' },
							{ id: 'next', label: 'Next segment' },
						],
					},
				],
				callback: (feedback) => {
					const previous = feedback.options.direction === 'previous'
					const moving = this.motion !== 'stopped'
					return {
						text: previous ? '◀ ☰' : '☰ ▶',
						size: '24',
						color: moving ? 0xaaaaaa : 0xffffff,
						bgcolor: moving ? 0x505050 : 0x202020,
					}
				},
			},
		}
	}
	private getVariables(): CompanionVariableDefinitions<VariableSchema> {
		return {
			playback_state: { name: 'Playback state (Playing, Paused, or Reverse)' },
			scroll_speed: { name: 'Current scroll speed' },
			playback_mode: { name: 'Playback mode (Manual or Timed)' },
			document_status: { name: 'Selected document connection status' },
			current_segment: { name: 'Current segment number and name' },
			timer_elapsed: { name: 'Live show elapsed time' },
			timer_remaining: { name: 'Estimated script time remaining' },
			timer_total: { name: 'Estimated total script time' },
			timer_ahead_behind: { name: 'Live schedule variance (positive ahead, negative behind)' },
		}
	}
	private getPresetStructure(): CompanionPresetSection<ModuleSchema>[] {
		return [
			{
				id: 'transport',
				name: 'Transport',
				definitions: ['play_pause_toggle', 'reverse', 'stop_reset', 'document_status'],
			},
			{
				id: 'speed',
				name: 'Speed',
				definitions: [
					'speed_auto',
					'speed_manual',
					'speed_indicator',
					'speed_up_5',
					'speed_up_1',
					'speed_down_5',
					'speed_down_1',
				],
			},
			{
				id: 'segments',
				name: 'Segments',
				definitions: ['current_segment_status', 'jump_segment', 'previous_segment', 'next_segment'],
			},
			{
				id: 'timers',
				name: 'Timers',
				definitions: ['timer_elapsed', 'timer_remaining', 'timer_total', 'timer_ahead_behind'],
			},
		]
	}
	private getPresets(): CompanionPresetDefinitions<ModuleSchema> {
		return {
			play_pause_toggle: {
				type: 'simple',
				name: 'Play / Pause toggle',
				keywords: ['play', 'pause', 'transport', 'toggle'],
				style: {
					text: '▶',
					size: '24',
					color: 0xffffff,
					bgcolor: 0x202020,
				},
				steps: [{ down: [{ actionId: 'toggle_play_pause', options: {} }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'is_playing',
						options: {},
						style: { bgcolor: 0x00aa00, color: 0xffffff, text: '❚❚' },
					},
				],
			},
			stop_reset: {
				type: 'simple',
				name: 'Stop & Reset',
				keywords: ['stop', 'reset', 'rewind', 'transport'],
				style: {
					text: '◀ ■',
					size: '24',
					color: 0xffffff,
					bgcolor: 0x000000,
				},
				steps: [{ down: [{ actionId: 'stop_reset', options: {} }], up: [] }],
				feedbacks: [{ feedbackId: 'stop_reset_confirmation', options: {} }],
			},
			document_status: {
				type: 'simple',
				name: 'Current document (indicator)',
				keywords: ['document', 'connection', 'status', 'indicator'],
				style: { text: '$(pavonine-teleprompter:document_status)', size: '14', color: 0xffffff, bgcolor: 0x8b0000 },
				steps: [{ down: [], up: [] }],
				feedbacks: [{ feedbackId: 'is_document_ready', options: {}, style: { bgcolor: 0x006400 } }],
			},
			current_segment_status: {
				type: 'simple',
				name: 'Current segment (indicator)',
				keywords: ['segment', 'current', 'status', 'indicator'],
				style: { text: '$(pavonine-teleprompter:current_segment)', size: '14', color: 0xffffff, bgcolor: 0x202020 },
				steps: [{ down: [], up: [] }],
				feedbacks: [],
			},
			timer_elapsed: this.timerPreset('Elapsed', 'timer_elapsed'),
			timer_remaining: this.timerPreset('Remaining', 'timer_remaining'),
			timer_total: this.timerPreset('Total', 'timer_total'),
			timer_ahead_behind: {
				type: 'simple',
				name: 'Ahead / Behind (indicator)',
				keywords: ['timer', 'ahead', 'behind', 'indicator'],
				style: {
					text: 'Ahead\n$(pavonine-teleprompter:timer_ahead_behind)',
					size: '14',
					color: 0xffffff,
					bgcolor: 0x000000,
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [{ feedbackId: 'timer_ahead_behind', options: {} }],
			},
			reverse: {
				type: 'simple',
				name: 'Reverse / Pause toggle',
				keywords: ['reverse', 'backward', 'transport'],
				style: {
					text: '◀',
					size: '24',
					color: 0xffffff,
					bgcolor: 0x202020,
				},
				steps: [{ down: [{ actionId: 'reverse', options: {} }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'is_reverse_playing',
						options: {},
						style: { bgcolor: 0x00aa00, color: 0xffffff, text: '❚❚\nREV' },
					},
				],
			},
			speed_indicator: {
				type: 'simple',
				name: 'Current speed (indicator)',
				keywords: ['speed', 'indicator', 'feedback'],
				style: { text: 'Speed\n$(pavonine-teleprompter:scroll_speed)', size: '18', color: 0xffffff, bgcolor: 0x202020 },
				steps: [{ down: [], up: [] }],
				feedbacks: [
					{ feedbackId: 'is_manual_speed_unavailable', options: {}, style: { bgcolor: 0x505050, color: 0xaaaaaa } },
				],
			},
			speed_auto: this.playbackModePreset(
				'Automatic speed mode',
				'Speed\nAUTO',
				'select_auto_mode',
				'is_auto_playback_mode',
			),
			speed_manual: this.playbackModePreset(
				'Manual speed mode',
				'Speed\nMANUAL',
				'select_manual_mode',
				'is_manual_playback_mode',
			),
			speed_up_5: this.speedPreset('Increase speed by 5%', '⌃⌃', 'speed_up_5'),
			speed_up_1: this.speedPreset('Increase speed by 1%', '⌃', 'speed_up_1'),
			speed_down_5: this.speedPreset('Decrease speed by 5%', '⌄⌄', 'speed_down_5'),
			speed_down_1: this.speedPreset('Decrease speed by 1%', '⌄', 'speed_down_1'),
			jump_segment: {
				type: 'simple',
				name: 'Jump to segment 1',
				keywords: ['segment', 'jump', '1'],
				style: { text: 'SEGMENT\n1', size: '14', color: 0xffffff, bgcolor: 0x000000 },
				// Companion actions and feedbacks have separate option objects, but a
				// button-local variable gives this template one shared edit point.
				localVariables: [
					{
						variableName: 'segment_index',
						headline: 'Segment number — change this one value when duplicating the button',
						variableType: 'simple',
						startupValue: 1,
					},
				],
				steps: [
					{
						down: [
							{
								actionId: 'jump_segment',
								options: { index: { value: '$(local:segment_index)', isExpression: true } },
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'segment_display',
						options: { index: { value: '$(local:segment_index)', isExpression: true } },
					},
					{
						feedbackId: 'segment_button_style',
						options: { index: { value: '$(local:segment_index)', isExpression: true } },
					},
				],
			},
			previous_segment: this.segmentNavigationPreset('Previous segment', '◀ ☰', 'previous_segment', 'previous'),
			next_segment: this.segmentNavigationPreset('Next segment', '☰ ▶', 'next_segment', 'next'),
		}
	}
	private speedPreset(
		name: string,
		text: string,
		actionId: 'speed_up_5' | 'speed_up_1' | 'speed_down_5' | 'speed_down_1',
	) {
		return {
			type: 'simple' as const,
			name,
			keywords: ['speed', 'transport'],
			style: { text, size: '24' as const, color: 0xffffff, bgcolor: 0x202020 },
			steps: [{ down: [{ actionId, options: {} }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'is_manual_speed_unavailable' as const,
					options: {},
					style: { bgcolor: 0x505050, color: 0xaaaaaa },
				},
			],
		}
	}
	private timerPreset(name: string, variable: 'timer_elapsed' | 'timer_remaining' | 'timer_total') {
		return {
			type: 'simple' as const,
			name: `${name} (indicator)`,
			keywords: ['timer', name.toLowerCase(), 'indicator'],
			style: {
				text: `${name}\n$(pavonine-teleprompter:${variable})`,
				size: '14' as const,
				color: 0xffffff,
				bgcolor: 0x000000,
			},
			steps: [{ down: [], up: [] }],
			feedbacks: [],
		}
	}
	private playbackModePreset(
		name: string,
		text: string,
		actionId: 'select_manual_mode' | 'select_auto_mode',
		feedbackId: 'is_manual_playback_mode' | 'is_auto_playback_mode',
	) {
		return {
			type: 'simple' as const,
			name,
			keywords: ['speed', 'mode', actionId === 'select_auto_mode' ? 'automatic' : 'manual'],
			style: { text, size: '14' as const, color: 0xffffff, bgcolor: 0x000000 },
			steps: [{ down: [{ actionId, options: {} }], up: [] }],
			feedbacks: [{ feedbackId, options: {}, style: { bgcolor: 0x00aa00, color: 0xffffff } }],
		}
	}
	private segmentNavigationPreset(
		name: string,
		text: string,
		actionId: 'previous_segment' | 'next_segment',
		direction: 'previous' | 'next',
	) {
		return {
			type: 'simple' as const,
			name,
			keywords: ['segment', 'navigation', actionId === 'previous_segment' ? 'previous' : 'next'],
			style: { text, size: '24' as const, color: 0xffffff, bgcolor: 0x202020 },
			steps: [{ down: [{ actionId, options: {} }], up: [] }],
			feedbacks: [{ feedbackId: 'segment_navigation_display' as const, options: { direction } }],
		}
	}
	private endpoint(): Endpoint | undefined {
		if (this.config.manual)
			return this.config.host && this.config.port ? { host: this.config.host, port: this.config.port } : undefined
		return this.devices.get(this.config.deviceId)
	}
	private connect(): void {
		this.destroyed = false
		if (this.socket || this.bridge || this.reconnectTimer) return
		this.log(
			'info',
			`Connecting to ${this.config.deviceId || 'no selected device'}; network key present: ${this.networkKey() ? 'yes' : 'no'}`,
		)
		const endpoint = this.endpoint()
		if (!endpoint) {
			this.updateStatus(InstanceStatus.Connecting, 'Searching for Teleprompter')
			return
		}
		const selectedDevice = this.devices.get(this.config.deviceId)
		if (selectedDevice && this.hasDifferentKey(selectedDevice)) {
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Different Network Key')
			return
		}
		if (this.networkKey()) {
			const unsupportedMessage = this.keyedTransportSupportMessage()
			if (unsupportedMessage) {
				this.updateStatus(InstanceStatus.ConnectionFailure, unsupportedMessage)
				return
			}
			const device = this.devices.get(this.config.deviceId)
			if (!device) {
				this.updateStatus(
					InstanceStatus.ConnectionFailure,
					'A discovered Teleprompter device is required when using a network key',
				)
				return
			}
			if (this.hasDifferentKey(device)) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Different Network Key')
				return
			}
			this.connectKeyed(device)
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		const socket = net.createConnection(endpoint)
		this.socket = socket
		socket.setNoDelay(true)
		socket.on('connect', () => this.connected())
		socket.on('data', (data) => this.receive(data))
		socket.on('error', (error) => {
			this.connectionActive = false
			this.updateDocumentStatus()
			this.updateStatus(InstanceStatus.ConnectionFailure, `Connection error: ${error.message}`)
			this.log('warn', `Teleprompter connection error: ${error.message}`)
		})
		socket.on('close', () => {
			if (this.socket === socket) this.socket = undefined
			if (!this.destroyed) this.scheduleReconnect()
		})
	}
	private connectKeyed(device: TeleprompterDevice): void {
		this.updateStatus(InstanceStatus.Connecting, 'Connecting with network key')
		this.keyedDataReceived = false
		const hostIndex = this.keyedHostIndex % device.hosts.length
		const endpoint: Endpoint = { host: device.hosts[hostIndex] ?? device.host, port: device.port }
		this.log('info', keyedConnectionLog(endpoint.host, endpoint.port, true))
		const psk = networkKeyMaterial(this.networkKey(), device.id)
		const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
		try {
			const addon = loadNativeTlsAddon(moduleDirectory)
			this.bridge = addon.start(
				endpoint.host,
				String(endpoint.port),
				psk,
				() => {
					this.log('info', 'Keyed Teleprompter transport authenticated')
					this.connected()
				},
				(data) => {
					if (!this.keyedDataReceived) {
						this.keyedDataReceived = true
						this.log('info', `Received ${data.length} bytes of encrypted Teleprompter state`)
					}
					this.receive(data)
				},
				(message) => {
					this.connectionActive = false
					this.updateDocumentStatus()
					this.log('warn', `Keyed transport error: ${message}`)
					this.updateStatus(InstanceStatus.ConnectionFailure, 'Keyed connection failed')
				},
			)
		} catch (error) {
			const message = (error as Error).message
			this.log('error', `Unable to load keyed transport: ${message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `Unable to start keyed transport: ${message}`)
		}
	}
	private connected(): void {
		this.connectionActive = true
		this.updateStatus(InstanceStatus.Ok, 'Discovering documents')
		this.updateDocumentStatus()
		this.noDocumentTimer = setTimeout(() => {
			if (this.documents.size === 0 && (this.socket || this.bridge))
				this.updateStatus(InstanceStatus.UnknownWarning, 'Connected, but Teleprompter has not sent its document list')
		}, 5000)
		if (!this.networkKey()) this.scheduleDocumentRefresh()
	}
	private disconnect(): void {
		this.connectionActive = false
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
		if (this.documentRefreshTimer) clearTimeout(this.documentRefreshTimer)
		if (this.segmentStatusTimer) clearInterval(this.segmentStatusTimer)
		if (this.timerStatusTimer) clearInterval(this.timerStatusTimer)
		this.reconnectTimer = undefined
		this.noDocumentTimer = undefined
		this.documentRefreshTimer = undefined
		this.segmentStatusTimer = undefined
		this.timerStatusTimer = undefined
		this.socket?.destroy()
		this.socket = undefined
		this.bridge = undefined
		this.receiveBuffer = Buffer.alloc(0)
		this.documentTimingSnapshots.clear()
		this.updateDocumentStatus()
	}
	private scheduleReconnect(): void {
		if (this.reconnectTimer) return
		this.updateStatus(InstanceStatus.ConnectionFailure, 'Connection closed; retrying')
		this.connectionActive = false
		this.updateDocumentStatus()
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			this.connect()
		}, 2000)
	}
	private scheduleDocumentRefresh(): void {
		if (this.documentRefreshTimer) clearTimeout(this.documentRefreshTimer)
		this.documentRefreshTimer = setTimeout(() => {
			this.documentRefreshTimer = undefined
			void this.refreshDocuments()
			if (!this.destroyed) this.scheduleDocumentRefresh()
		}, 10_000)
	}
	private async refreshDocuments(): Promise<boolean> {
		// A keyed session is TLS-PSK; the persistent bridge already receives its
		// snapshot. Do not open an unauthenticated refresh socket alongside it.
		if (this.networkKey()) return this.hasSelectedDocumentTimingSnapshot()
		const endpoint = this.endpoint()
		if (!endpoint || this.destroyed) return false
		return new Promise<boolean>((resolve) => {
			const refreshStartedAt = Date.now()
			let buffer = Buffer.alloc(0)
			let finished = false
			let timeout: NodeJS.Timeout | undefined
			const socket = net.createConnection(endpoint)
			const finish = (found = false): void => {
				if (finished) return
				finished = true
				if (timeout) clearTimeout(timeout)
				socket.destroy()
				resolve(found)
			}
			socket.setNoDelay(true)
			socket.on('data', (data) => {
				buffer = Buffer.concat([buffer, data])
				while (buffer.length >= 8) {
					const length = buffer.readBigInt64LE()
					if (length <= 0n || length >= 2n ** 32n) {
						buffer = buffer.subarray(8)
						continue
					}
					const end = 8 + Number(length)
					if (buffer.length < end) return
					const payload = buffer.subarray(8, end)
					buffer = buffer.subarray(end)
					if (payload.length === 0) continue
					try {
						const message = parseTreeMessage(payload.toString('utf8'))
						this.observeSequence(message)
						const documents = this.snapshotDocuments(message)
						if (documents.size > 0) {
							this.replaceDocuments(documents)
							return finish((this.documentTimingSnapshots.get(this.config.documentId) ?? 0) >= refreshStartedAt)
						}
					} catch {
						// Ignore malformed frames from this best-effort refresh connection.
					}
				}
			})
			socket.on('error', finish)
			socket.on('close', finish)
			timeout = setTimeout(finish, 5000)
		})
	}
	private receive(data: Buffer): void {
		const decoded = decodeFrames(Buffer.concat([this.receiveBuffer, data]))
		this.receiveBuffer = Buffer.from(decoded.remainder)
		for (const payload of decoded.frames) {
			if (payload.length === 0) continue
			try {
				const message = parseTreeMessage(payload.toString('utf8'))
				this.observeSequence(message)
				this.readDocuments(message)
			} catch {
				this.log('warn', 'Received a non-JSON Teleprompter frame')
			}
		}
	}
	private observeSequence(message: unknown): void {
		const observed = maximumObservedIndex(message)
		if (observed !== undefined && observed > this.maximumIndex) this.maximumIndex = observed
	}
	private readDocuments(message: unknown): void {
		const visit = (node: unknown): void => {
			if (!Array.isArray(node)) return
			for (let index = 0; index < node.length; index += 1) {
				const value = node[index]
				// Closing a document is an unset at the document root, rather than
				// an update to its name. Treat it as authoritative so a subsequently
				// opened document cannot leave a stale UUID selected in Companion.
				const removedDocument = removedDocumentId(value, node[index + 1])
				if (removedDocument) this.removeDocument(removedDocument)
				if (this.isMotionPath(value)) {
					const motion = this.findTimingMotion(node[index + 1]) ?? 'stopped'
					this.documentMotions.set(value[1], motion)
					if (value[1] === this.config.documentId) this.setPlaybackState(motion, true)
				}
				if (this.isTimingValuePath(value)) {
					const type = value[4] === 'keyTime' ? 'Delta' : 'CGFloat'
					const number = this.findTypedNumber(node[index + 1], type)
					if (number !== undefined) {
						const current = this.documentTiming.get(value[1]) ?? { keyPosition: 0, keyTime: 0, receivedAt: Date.now() }
						this.documentTiming.set(value[1], {
							...current,
							...(value[4] === 'keyTime'
								? { keyTime: number }
								: value[4] === 'scrolledPosition'
									? { scrolledPosition: number }
									: { keyPosition: number }),
							receivedAt: Date.now(),
						})
						this.updateSegmentStatus()
					}
				}
				if (this.isTimerStartPath(value)) {
					const elapsed = this.findTypedNumber(node[index + 1], 'Delta')
					if (elapsed === undefined) this.documentTimerStarts.delete(value[1])
					else this.documentTimerStarts.set(value[1], { elapsed, receivedAt: Date.now() })
					this.refreshTimerStatus()
				}
				if (this.isManualSpeedPath(value)) {
					const speed = this.findTypedNumber(node[index + 1], 'Double')
					if (speed !== undefined) this.setDocumentSpeed(value[1], speed)
				}
				if (this.isMaximumSpeedPath(value)) {
					const maximum = this.findTypedNumber(node[index + 1], 'Double')
					if (maximum !== undefined) this.documentMaximumSpeeds.set(value[1], maximum)
				}
				if (this.isSelectorPath(value)) {
					const selector = this.findTypedValue(node[index + 1], 'Timing.Selector')
					if (selector === 'manual' || selector === 'timed') this.setDocumentSelector(value[1], selector)
				}
				if (this.isDocumentNamePath(value)) {
					const name = this.findStringValue(node[index + 1])
					if (name && this.documents.get(value[1]) !== name) {
						this.documents.set(value[1], name)
						this.rememberOrRestoreDocument(value[1], name)
						if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
						this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
						this.selectOnlyDocument()
						this.updateDocumentStatus()
					}
				}
				visit(value)
			}
		}
		visit(message)
		this.readDocumentSnapshots(message)
	}
	private readDocumentSnapshots(message: unknown): void {
		const documents = this.snapshotDocuments(message)
		for (const [documentId, name] of documents) {
			if (this.documents.get(documentId) !== name) {
				this.documents.set(documentId, name)
				this.rememberOrRestoreDocument(documentId, name)
				if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
				this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
				this.selectOnlyDocument()
				this.updateDocumentStatus()
			}
		}
	}
	private snapshotDocuments(message: unknown): Map<string, string> {
		const documents = new Map<string, string>()
		const findDocuments = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const child of node) findDocuments(child)
				return
			}
			if (!node || typeof node !== 'object') return
			const record = node as Record<string, unknown>
			if (record.documents) {
				const documentMap = this.findCrdtObject(record.documents)
				if (documentMap) {
					for (const [documentId, documentValue] of Object.entries(documentMap)) {
						const document = this.findCrdtObject(documentValue)
						const name = document ? this.findTypedValue(document.name, 'String') : undefined
						const model = document ? this.findCrdtObject(document.model) : undefined
						const timing = model ? this.findCrdtObject(model.timing) : undefined
						const timerInfo = document ? this.findCrdtObject(model?.timerInfo) : undefined
						const timerStart = this.findTypedNumber(timerInfo?.timerStart, 'Delta')
						if (timerStart === undefined) this.documentTimerStarts.delete(documentId)
						else this.documentTimerStarts.set(documentId, { elapsed: timerStart, receivedAt: Date.now() })
						const speed = this.findTypedNumber(timing?.manualSpeed, 'Double')
						const maximumSpeed = this.findTypedNumber(model?.maximumSpeed, 'Double')
						const maximumPosition = this.findTypedNumber(model?.maximumPosition, 'CGFloat')
						const keyPosition = this.findTypedNumber(timing?.keyPosition, 'CGFloat')
						const scrolledPosition = this.findTypedNumber(timing?.scrolledPosition, 'CGFloat')
						const keyTime = this.findTypedNumber(timing?.keyTime, 'Delta')
						if (keyPosition !== undefined || scrolledPosition !== undefined || keyTime !== undefined) {
							const previous = this.documentTiming.get(documentId)
							this.documentTiming.set(documentId, {
								keyPosition: keyPosition ?? previous?.keyPosition ?? 0,
								keyTime: keyTime ?? previous?.keyTime ?? 0,
								scrolledPosition: scrolledPosition ?? previous?.scrolledPosition,
								maximumPosition: maximumPosition ?? previous?.maximumPosition,
								receivedAt: Date.now(),
							})
							this.documentTimingSnapshots.set(documentId, Date.now())
							this.updateSegmentStatus()
						}
						if (speed !== undefined) this.setDocumentSpeed(documentId, speed)
						if (maximumSpeed !== undefined) this.documentMaximumSpeeds.set(documentId, maximumSpeed)
						const selector = this.findTypedValue(timing?.selector, 'Timing.Selector')
						if (selector === 'manual' || selector === 'timed') this.setDocumentSelector(documentId, selector)
						if (model) this.readSegments(documentId, model)
						this.refreshTimerStatus()
						const motion = this.findTimingMotion(timing?.motion) ?? 'stopped'
						this.documentMotions.set(documentId, motion)
						if (documentId === this.config.documentId) this.setPlaybackState(motion, true)
						if (name) {
							documents.set(documentId, name)
						}
					}
				}
			}
			for (const child of Object.values(record)) findDocuments(child)
		}
		findDocuments(message)
		return documents
	}
	private replaceDocuments(documents: Map<string, string>): void {
		const changed = JSON.stringify([...this.documents]) !== JSON.stringify([...documents])
		if (!changed) return
		this.documents.clear()
		for (const [documentId, name] of documents) this.documents.set(documentId, name)
		for (const [documentId, name] of this.documents) this.rememberOrRestoreDocument(documentId, name)
		this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
		this.selectOnlyDocument()
		this.updateDocumentStatus()
	}
	private removeDocument(documentId: string): void {
		const removed = this.documents.delete(documentId)
		this.documentMotions.delete(documentId)
		this.documentTiming.delete(documentId)
		this.documentTimingSnapshots.delete(documentId)
		this.documentSpeeds.delete(documentId)
		this.documentTimerStarts.delete(documentId)
		this.documentTimingFunctions.delete(documentId)
		this.documentSegments.delete(documentId)
		if (this.config.documentId === documentId) {
			this.setPlaybackState('stopped', true)
			this.setVariableValues({ scroll_speed: '' })
		}
		if (removed) this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
		this.updateDocumentStatus()
		this.updateSegmentStatus()
	}
	private findCrdtObject(value: unknown): Record<string, unknown> | undefined {
		if (!Array.isArray(value)) return undefined
		if (value[0] === 4 && value[1] && typeof value[1] === 'object' && !Array.isArray(value[1])) {
			return value[1] as Record<string, unknown>
		}
		for (const child of value) {
			const found = this.findCrdtObject(child)
			if (found) return found
		}
		return undefined
	}
	private isDocumentNamePath(value: unknown): value is [string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 3 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'name'
		)
	}
	private isMotionPath(value: unknown): value is [string, string, string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 5 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'timing' &&
			value[4] === 'motion'
		)
	}
	private isTimingValuePath(
		value: unknown,
	): value is [string, string, string, string, 'keyPosition' | 'keyTime' | 'scrolledPosition'] {
		return (
			Array.isArray(value) &&
			value.length === 5 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'timing' &&
			(value[4] === 'keyPosition' || value[4] === 'keyTime' || value[4] === 'scrolledPosition')
		)
	}
	private isTimerStartPath(value: unknown): value is [string, string, string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 5 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'timerInfo' &&
			value[4] === 'timerStart'
		)
	}
	private isManualSpeedPath(value: unknown): value is [string, string, string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 5 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'timing' &&
			value[4] === 'manualSpeed'
		)
	}
	private isMaximumSpeedPath(value: unknown): value is [string, string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 4 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'maximumSpeed'
		)
	}
	private isSelectorPath(value: unknown): value is [string, string, string, string, string] {
		return (
			Array.isArray(value) &&
			value.length === 5 &&
			value[0] === 'documents' &&
			typeof value[1] === 'string' &&
			value[2] === 'model' &&
			value[3] === 'timing' &&
			value[4] === 'selector'
		)
	}
	private findStringValue(value: unknown): string | undefined {
		if (!Array.isArray(value)) return undefined
		if (value[0] === 'String' && typeof value[1] === 'string') return value[1]
		for (const child of value) {
			const found = this.findStringValue(child)
			if (found) return found
		}
		return undefined
	}
	private findTypedValue(value: unknown, type: string): string | undefined {
		if (!Array.isArray(value)) return undefined
		if (value[0] === type && typeof value[1] === 'string') return value[1]
		for (const child of value) {
			const found = this.findTypedValue(child, type)
			if (found) return found
		}
		return undefined
	}
	private findTypedNumber(value: unknown, type: string): number | undefined {
		if (!Array.isArray(value)) return undefined
		if (value[0] === type && typeof value[1] === 'number' && Number.isFinite(value[1])) return value[1]
		for (const child of value) {
			const found = this.findTypedNumber(child, type)
			if (found !== undefined) return found
		}
		return undefined
	}
	private findTimingMotion(value: unknown): Motion | undefined {
		if (!Array.isArray(value)) return undefined
		if (value[0] === 'Timing.Motion' && (value[1] === 'forward' || value[1] === 'reverse')) return value[1]
		for (const child of value) {
			const found = this.findTimingMotion(child)
			if (found) return found
		}
		return undefined
	}
	private setPlaybackState(motion: Motion, _authoritative = false): void {
		this.motion = motion
		this.setVariableValues({
			playback_state: motion === 'forward' ? 'Playing' : motion === 'reverse' ? 'Reverse' : 'Paused',
		})
		// Segment identity may remain unchanged when motion changes, but numbered
		// segment controls still need to switch between their active/gray styles.
		this.checkFeedbacks(
			'is_playing',
			'is_reverse_playing',
			'is_segment_active',
			'is_segment_active_moving',
			'is_segment_unavailable',
			'segment_button_style',
			'segment_display',
			'segment_navigation_display',
		)
		this.updateSegmentStatus()
		this.updateSegmentStatusTracking()
	}
	private setDocumentSpeed(documentId: string, speed: number): void {
		this.documentSpeeds.set(documentId, speed)
		if (documentId === this.config.documentId)
			this.setVariableValues({ scroll_speed: speedLabel(speed, this.documentMaximumSpeeds.get(documentId)) })
	}
	private setDocumentSelector(documentId: string, selector: 'manual' | 'timed'): void {
		this.documentSelectors.set(documentId, selector)
		if (documentId === this.config.documentId) {
			this.setVariableValues({ playback_mode: selector === 'timed' ? 'TIMED' : 'MANUAL' })
			this.checkFeedbacks('is_manual_playback_mode', 'is_auto_playback_mode', 'is_manual_speed_unavailable')
		}
	}
	private selectedPlaybackMode(): 'manual' | 'timed' | undefined {
		return this.documentSelectors.get(this.config.documentId)
	}
	private currentTimerValues():
		{ elapsed: number; remaining?: number; total?: number; aheadBehind?: number } | undefined {
		const documentId = this.config.documentId
		if (!documentId || !this.hasSelectedDocumentTimingSnapshot()) return undefined
		const timerStart = this.documentTimerStarts.get(documentId)
		const elapsed = timerStart ? timerStart.elapsed + (Date.now() - timerStart.receivedAt) / 1000 : 0
		const timing = this.currentTiming(documentId)
		const maximum = timing.maximumPosition
		if (maximum === undefined) return { elapsed }
		const position = timing.keyPosition
		const points = this.documentTimingFunctions.get(documentId) ?? []
		const scheduled = interpolateTimerTime(points, position)
		if (this.selectedPlaybackMode() === 'timed' && points.length && scheduled !== undefined) {
			const total = points.at(-1)?.time
			return {
				elapsed,
				total,
				remaining: total === undefined ? undefined : Math.max(0, total - scheduled),
				aheadBehind: scheduled - elapsed,
			}
		}
		const speed = this.documentSpeeds.get(documentId)
		if (speed === undefined || speed <= 0)
			return { elapsed, aheadBehind: scheduled === undefined ? undefined : scheduled - elapsed }
		return {
			elapsed,
			total: maximum / speed,
			remaining: Math.max(0, maximum - position) / speed,
			aheadBehind: scheduled === undefined ? undefined : scheduled - elapsed,
		}
	}
	private refreshTimerStatus(): void {
		const values = this.currentTimerValues()
		this.setVariableValues({
			timer_elapsed: formatDuration(values?.elapsed ?? 0),
			timer_remaining: values?.remaining === undefined ? '—' : formatDuration(values.remaining),
			timer_total: values?.total === undefined ? '—' : formatDuration(values.total),
			timer_ahead_behind:
				values?.aheadBehind === undefined
					? '—'
					: `${values.aheadBehind < 0 ? '-' : ''}${formatDuration(Math.abs(values.aheadBehind))}`,
		})
		this.checkFeedbacks('timer_ahead_behind')
	}
	private readSegments(documentId: string, model: Record<string, unknown>): void {
		const timing = this.findCrdtObject(model.timing)
		const timingFunction = this.findTypedRecord(timing?.markersTimingFunction, 'MarkersTimingFunction')
		const functionMaximumPosition =
			typeof timingFunction?.maximumPosition === 'number' && Number.isFinite(timingFunction.maximumPosition)
				? timingFunction.maximumPosition
				: undefined
		if (functionMaximumPosition !== undefined) {
			const previous = this.documentTiming.get(documentId) ?? { keyPosition: 0, keyTime: 0 }
			this.documentTiming.set(documentId, { ...previous, maximumPosition: functionMaximumPosition })
		}
		const keyPoints = Array.isArray(timingFunction?.keyPoints) ? timingFunction.keyPoints : []
		const positions = new Map<string, number>()
		const timerPoints: Array<{ position: number; time: number }> = []
		for (const keyPoint of keyPoints) {
			if (!keyPoint || typeof keyPoint !== 'object') continue
			const point = keyPoint as Record<string, unknown>
			if (
				typeof point.markerUUID !== 'string' ||
				typeof point.position !== 'number' ||
				!Number.isFinite(point.position)
			)
				continue
			const previous = positions.get(point.markerUUID)
			if (previous === undefined || point.position < previous) positions.set(point.markerUUID, point.position)
			if (typeof point.time === 'number' && Number.isFinite(point.time))
				timerPoints.push({ position: point.position, time: point.time })
		}
		timerPoints.sort((a, b) => a.position - b.position || a.time - b.time)
		if (timerPoints.length) this.documentTimingFunctions.set(documentId, timerPoints)
		else this.documentTimingFunctions.delete(documentId)
		const markers = new Map<string, { name: string; pauseEnabled: boolean; pauseDuration: number }>()
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const child of value) visit(child)
				return
			}
			if (!value || typeof value !== 'object') return
			const record = value as Record<string, unknown>
			const id = typeof record.uuid === 'string' ? record.uuid : this.findTypedValue(record.uuid, 'UUID')
			const name = typeof record.name === 'string' ? record.name : this.findTypedValue(record.name, 'String')
			if (id && name) {
				const pause = this.findTypedRecord(record.pauseBefore, 'TimingMarker.Pause')
				markers.set(id, {
					name,
					pauseEnabled: pause?.enabled === true,
					pauseDuration: typeof pause?.duration === 'number' && Number.isFinite(pause.duration) ? pause.duration : 0,
				})
			}
			for (const child of Object.values(record)) visit(child)
		}
		visit(model.markers)
		const segments = [...markers.entries()]
			.flatMap(([id, marker]) => {
				const position = positions.get(id)
				return position === undefined ? [] : [{ id, position, ...marker }]
			})
			.sort((a, b) => a.position - b.position)
			.map((segment, index) => ({ ...segment, index: index + 1 }))
		if (JSON.stringify(this.documentSegments.get(documentId)) === JSON.stringify(segments)) return
		this.documentSegments.set(documentId, segments)
		this.refreshSegmentDefinitions()
		this.updateSegmentStatus()
		this.refreshTimerStatus()
	}
	private findTypedRecord(value: unknown, type: string): Record<string, unknown> | undefined {
		if (Array.isArray(value)) {
			if (value[0] === type && value[1] && typeof value[1] === 'object' && !Array.isArray(value[1]))
				return value[1] as Record<string, unknown>
			for (const child of value) {
				const found = this.findTypedRecord(child, type)
				if (found) return found
			}
		} else if (value && typeof value === 'object') {
			for (const child of Object.values(value)) {
				const found = this.findTypedRecord(child, type)
				if (found) return found
			}
		}
		return undefined
	}
	private currentSegments(): Segment[] {
		return this.documentSegments.get(this.config.documentId) ?? []
	}
	private activeSegment(): Segment | undefined {
		if (!this.hasSelectedDocumentTimingSnapshot()) return undefined
		const segments = this.currentSegments()
		const position = this.currentTiming(this.config.documentId).keyPosition
		return [...segments].reverse().find((segment) => position >= segment.position)
	}
	private updateSegmentStatus(): void {
		if (this.config.documentId && !this.hasSelectedDocumentTimingSnapshot()) {
			this.setSegmentStatus('SYNCING\nDOCUMENT')
			this.refreshSegmentFeedbacks()
			return
		}
		const segments = this.currentSegments()
		const active = this.activeSegment()
		const currentSegment = active
			? `${active.index}\n${active.name}`
			: segments.length
				? 'BEFORE\nSEGMENT 1'
				: 'NO SEGMENTS'
		this.setSegmentStatus(currentSegment)
		// Run at every timer tick while moving.  The position can cross a marker
		// even when the displayed status text is unchanged for other reasons.
		this.refreshSegmentFeedbacks()
	}
	private setSegmentStatus(value: string): void {
		if (value === this.lastSegmentStatus) return
		this.lastSegmentStatus = value
		this.setVariableValues({ current_segment: value })
	}
	private refreshSegmentFeedbacks(): void {
		this.checkFeedbacks(
			'is_segment_active',
			'is_segment_active_moving',
			'is_segment_unavailable',
			'segment_button_style',
			'segment_display',
		)
	}
	private updateSegmentStatusTracking(): void {
		if (this.segmentStatusTimer) clearInterval(this.segmentStatusTimer)
		this.segmentStatusTimer = undefined
		if (this.motion === 'stopped' || !this.config.documentId) return
		// Teleprompter publishes a position at command boundaries, not continuously.
		// Re-evaluate our locally estimated playhead while moving so segment feedback
		// changes promptly when crossing either direction's marker boundary.
		this.segmentStatusTimer = setInterval(() => this.updateSegmentStatus(), 100)
	}
	private refreshSegmentDefinitions(): void {
		this.setPresetDefinitions(this.getPresetStructure(), this.getPresets())
	}
	private async jumpToSegment(index: number, synchronize = true): Promise<void> {
		this.cancelStopResetConfirmation()
		try {
			if (synchronize && !(await this.refreshDocuments()))
				throw new Error('Unable to synchronize the current document; command not sent')
			const documentId = this.documentId()
			if ((this.documentMotions.get(documentId) ?? 'stopped') !== 'stopped')
				throw new Error('Pause the Teleprompter before jumping to a segment; command not sent')
			const segment = this.documentSegments.get(documentId)?.find((candidate) => candidate.index === index)
			if (!segment) throw new Error(`Segment ${index} is not available for the selected document`)
			const current = this.documentTiming.get(documentId)?.keyPosition ?? 0
			const data = segmentJumpMutation(documentId, current, segment.position, this.nextSequence())
			this.log(
				'info',
				`Segment ${index} jump requested; writing ${data.length} bytes from ${current} to ${segment.position}`,
			)
			await this.send(data)
			this.documentTiming.set(documentId, {
				...this.documentTiming.get(documentId),
				keyPosition: segment.position,
				keyTime: 0,
				scrolledPosition: segment.position,
				receivedAt: Date.now(),
			})
			this.updateSegmentStatus()
			this.log('info', `Segment ${index} jump sent`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `Segment ${index} jump failed: ${message}`)
			throw error
		}
	}
	private async jumpAdjacentSegment(direction: -1 | 1): Promise<void> {
		this.cancelStopResetConfirmation()
		if (!(await this.refreshDocuments()))
			throw new Error('Unable to synchronize the current document; command not sent')
		const segments = this.currentSegments()
		if (segments.length === 0) throw new Error('No segments are available for the selected document')
		const active = this.activeSegment()
		const targetIndex = active ? active.index + direction : 1
		const target = segments.find((segment) => segment.index === targetIndex)
		if (!target) return
		await this.jumpToSegment(target.index, false)
	}
	private selectOnlyDocument(): void {
		const documentId = automaticallySelectedDocument(this.documents, this.config.documentId)
		if (!documentId) return
		this.config = { ...this.config, documentId, documentName: this.documents.get(documentId) ?? '' }
		this.saveConfig(this.config)
		this.setPlaybackState(this.documentMotions.get(documentId) ?? 'stopped', true)
		const speed = this.documentSpeeds.get(documentId)
		if (speed !== undefined) this.setDocumentSpeed(documentId, speed)
		const selector = this.documentSelectors.get(documentId)
		if (selector) this.setDocumentSelector(documentId, selector)
		this.log('info', `Automatically selected the only available document: ${this.documents.get(documentId)}`)
		this.updateDocumentStatus()
	}
	private rememberOrRestoreDocument(documentId: string, name: string): void {
		if (documentId === this.config.documentId && this.config.documentName !== name) {
			this.config = { ...this.config, documentName: name }
			this.saveConfig(this.config)
			return
		}
		// A deliberately closed/reopened file can be represented by a new CRDT
		// UUID. Reassociate only when the old selected UUID is absent and exactly
		// one currently advertised file has the saved name.
		if (
			this.config.documentId &&
			!this.documents.has(this.config.documentId) &&
			this.config.documentName === name &&
			[...this.documents.values()].filter((candidate) => candidate === name).length === 1
		) {
			this.config = { ...this.config, documentId }
			this.saveConfig(this.config)
			this.log('info', `Restored saved document selection: ${name}`)
		}
	}
	private updateDocumentStatus(): void {
		const selectedReady = this.hasSelectedDocumentTimingSnapshot()
		this.setVariableValues({
			document_status:
				this.connectionActive && this.documents.has(this.config.documentId) && !selectedReady
					? `SYNCING\n${this.documents.get(this.config.documentId)}`
					: documentStatus(this.connectionActive, this.documents, this.config.documentId, this.config.documentName),
		})
		this.checkFeedbacks('is_document_ready')
	}
	private hasSelectedDocumentTimingSnapshot(): boolean {
		return hasFreshDocumentTimingSnapshot(this.config.documentId, this.documentTimingSnapshots)
	}
	private documentId(): string {
		if (!this.config.documentId) throw new Error('Select a document after it has been discovered')
		if (!this.documents.has(this.config.documentId))
			throw new Error('The selected document is closed or unavailable; command not sent')
		if (!this.hasSelectedDocumentTimingSnapshot())
			throw new Error('The selected document has not provided a fresh timing snapshot; command not sent')
		return this.config.documentId.toUpperCase()
	}
	private nextSequence(): bigint {
		let increment = randomBytes(8).readBigUInt64LE()
		if (increment === 0n) increment = 1n
		const next = this.maximumIndex + increment
		this.maximumIndex = next
		return next
	}
	private transport(motion: Motion): { data: Buffer; documentId: string; timing: TimingState } {
		const documentId = this.documentId()
		// A fresh snapshot is authoritative when starting from a pause. While
		// already moving its position remains the starting anchor, so TP Controller
		// advances a local playhead before either Pause or a direction switch.
		const position = this.currentTiming(documentId)
		const timing = { ...position, keyTime: 0, receivedAt: Date.now() }
		return {
			data: transportMutation(
				documentId,
				motion,
				timing,
				this.nextSequence(),
				motion === 'forward' && !this.documentTimerStarts.has(documentId),
			),
			documentId,
			timing,
		}
	}
	private async runTransport(motion: Motion): Promise<void> {
		this.cancelStopResetConfirmation()
		try {
			if (!maySendTransport(await this.refreshDocuments(), this.config.documentId))
				throw new Error('Unable to synchronize the Teleprompter position; command not sent')
			const { data, documentId, timing } = this.transport(motion)
			this.log('info', `Transport action requested: ${motion}; writing ${data.length} bytes`)
			await this.send(data)
			// `timing` is the action's exact current anchor. It must become the
			// new estimate origin as-is: re-estimating during a direction switch
			// would apply the just-elapsed movement a second time.
			this.documentTiming.set(documentId, timing)
			this.documentMotions.set(documentId, motion)
			// Teleprompter creates timerStart on the first forward play after reset.
			// Mirror that origin immediately; a remote echo may arrive much later.
			if (motion === 'forward' && !this.documentTimerStarts.has(documentId))
				this.documentTimerStarts.set(documentId, { elapsed: 0, receivedAt: Date.now() })
			this.updateSegmentStatus()
			this.refreshTimerStatus()
			// A playing Teleprompter normally sends no intermediate state updates;
			// keep the toggle authoritative until it next reports a state change.
			this.setPlaybackState(motion)
			this.log('info', `Transport action sent: ${motion}`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `Transport action failed: ${message}`)
			throw error
		}
	}
	private async requestStopReset(): Promise<void> {
		if (stopResetPress(this.stopResetConfirmationPending) === 'confirm') {
			this.stopResetConfirmationPending = true
			this.stopResetFlashOn = true
			this.stopResetConfirmationTimer = setTimeout(() => this.cancelStopResetConfirmation(), 3000)
			this.stopResetFlashTimer = setInterval(() => {
				this.stopResetFlashOn = !this.stopResetFlashOn
				this.checkFeedbacks('stop_reset_confirmation')
			}, 350)
			this.checkFeedbacks('stop_reset_confirmation')
			return
		}
		this.cancelStopResetConfirmation()
		await this.runReset()
	}
	private cancelStopResetConfirmation(): void {
		if (this.stopResetConfirmationTimer) clearTimeout(this.stopResetConfirmationTimer)
		if (this.stopResetFlashTimer) clearInterval(this.stopResetFlashTimer)
		const wasPending = this.stopResetConfirmationPending
		this.stopResetConfirmationTimer = undefined
		this.stopResetFlashTimer = undefined
		this.stopResetConfirmationPending = false
		this.stopResetFlashOn = false
		if (wasPending) this.checkFeedbacks('stop_reset_confirmation')
	}
	private async runReset(): Promise<void> {
		const documentId = this.documentId()
		try {
			const data = resetMutation(documentId, this.nextSequence())
			this.log('info', `Stop & Reset requested; writing ${data.length} bytes`)
			await this.send(data)
			// The wire reset moves the visible scroll to zero. Mirror that locally so
			// the following Play uses zero rather than the prior pause position.
			this.documentTiming.set(documentId, {
				...this.documentTiming.get(documentId),
				keyPosition: 0,
				keyTime: 0,
				scrolledPosition: 0,
				receivedAt: Date.now(),
			})
			this.documentMotions.set(documentId, 'stopped')
			this.documentTimerStarts.delete(documentId)
			this.updateSegmentStatus()
			this.refreshTimerStatus()
			this.setPlaybackState('stopped')
			this.log('info', 'Stop & Reset sent')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `Stop & Reset failed: ${message}`)
			throw error
		}
	}
	private async adjustSpeed(percentDelta: number): Promise<void> {
		this.cancelStopResetConfirmation()
		if (!(await this.refreshDocuments())) throw new Error('Unable to synchronize the current speed; command not sent')
		const documentId = this.documentId()
		const current = this.documentSpeeds.get(documentId)
		if (current === undefined) throw new Error('Teleprompter did not provide its current speed; command not sent')
		await this.setManualSpeed(current + percentDelta * 5, false)
	}
	private async setManualSpeed(requested: number, synchronize = true): Promise<void> {
		this.cancelStopResetConfirmation()
		if (synchronize && !(await this.refreshDocuments()))
			throw new Error('Unable to synchronize the current speed; command not sent')
		const documentId = this.documentId()
		if (this.documentSelectors.get(documentId) === 'timed')
			throw new Error('Teleprompter is using timed playback; manual speed is inactive')
		const next = clampManualSpeed(requested, this.documentMaximumSpeeds.get(documentId))
		const timing = this.currentTiming(documentId)
		await this.send(
			speedMutation(documentId, next, { ...timing, keyTime: 0, receivedAt: Date.now() }, this.nextSequence()),
		)
		this.documentTiming.set(documentId, { ...timing, keyTime: 0, receivedAt: Date.now() })
		this.setDocumentSpeed(documentId, next)
	}
	private async setPlaybackMode(selector: 'manual' | 'timed'): Promise<void> {
		this.cancelStopResetConfirmation()
		if (!(await this.refreshDocuments())) throw new Error('Unable to synchronize the playback mode; command not sent')
		const documentId = this.documentId()
		await this.send(selectorMutation(documentId, selector, this.nextSequence()))
		this.setDocumentSelector(documentId, selector)
	}
	private currentTiming(documentId: string): TimingState {
		const timing = this.documentTiming.get(documentId) ?? { keyPosition: 0, keyTime: 0 }
		const motion = this.documentMotions.get(documentId) ?? this.motion
		const keyPosition = evaluateTiming(timing, motion, this.documentSpeeds.get(documentId) ?? 100, Date.now())
		return { ...timing, keyPosition, keyTime: 0, receivedAt: Date.now(), scrolledPosition: keyPosition }
	}
	private async send(data: Buffer): Promise<void> {
		if (this.bridge) {
			const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
			const addon = loadNativeTlsAddon(moduleDirectory)
			addon.send(this.bridge, data)
			return
		}
		if (!this.socket || this.socket.destroyed || !this.socket.writable) throw new Error('Teleprompter is not connected')
		await new Promise<void>((resolve, reject) =>
			this.socket?.write(data, (error) => (error ? reject(error) : resolve())),
		)
	}
	public async destroy(): Promise<void> {
		this.destroyed = true
		this.cancelStopResetConfirmation()
		this.disconnect()
		if (this.discoveryRefreshTimer) clearInterval(this.discoveryRefreshTimer)
		this.browser?.stop()
		this.bonjour?.destroy()
	}
}
