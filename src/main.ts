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
import { createHash, pbkdf2Sync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { resetMutation, speedMutation, transportMutation, type Motion, type TimingState } from './protocol.js'
const nodeRequire = createRequire(import.meta.url)
type NativeTlsAddon = { start(host: string, port: string, psk: Buffer, ready: () => void, data: (data: Buffer) => void, error: (message: string) => void): unknown; send(connection: unknown, data: Buffer): void }

interface Config {
	[key: string]: string | number | boolean | null
	deviceId: string
	manual: boolean
	host: string
	port: number
	documentId: string
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
	toggle_play_pause: { options: Record<string, never> }
}
type FeedbackSchema = {
	is_playing: { type: 'boolean'; options: Record<string, never> }
	is_reverse_playing: { type: 'boolean'; options: Record<string, never> }
}
type VariableSchema = { playback_state: string; scroll_speed: string }
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

export default class TeleprompterInstance extends InstanceBase<ModuleSchema> {
	private config: Config = { deviceId: '', manual: false, host: '', port: 65330, documentId: '' }
	private secrets: Secrets = { networkKey: '' }
	// Teleprompter compares this app-wide CRDT revision before the actor clock.
	// A reinstall loses module-local state, so use a millisecond epoch clock: it
	// is safe as an IEEE-754 integer and newer than prior controller sessions.
	private sequence = BigInt(Date.now())
	private socket: net.Socket | undefined
	private bridge: unknown
	private keyedDataReceived = false
	private receiveBuffer = Buffer.alloc(0)
	private reconnectTimer: NodeJS.Timeout | undefined
	private noDocumentTimer: NodeJS.Timeout | undefined
	private documentRefreshTimer: NodeJS.Timeout | undefined
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
	private readonly documentSpeeds = new Map<string, number>()
	private readonly timerNeedsStart = new Set<string>()
	private playbackStartedAt: number | undefined
	private motion: Motion = 'stopped'

	public async init(config: Config, _isFirstInit: boolean, secrets: Secrets): Promise<void> {
		this.config = config
		this.secrets = { networkKey: secrets?.networkKey ?? '' }
		this.setActionDefinitions(this.getActions())
		this.setFeedbackDefinitions(this.getFeedbacks())
		this.setVariableDefinitions(this.getVariables())
		this.setPresetDefinitions(this.getPresetStructure(), this.getPresets())
		this.setVariableValues({ scroll_speed: '—%' })
		this.setPlaybackState('stopped')
		this.startDiscovery()
		this.connect()
	}
	public async configUpdated(config: Config, secrets: Secrets): Promise<void> {
		const deviceChanged = config.deviceId !== this.config.deviceId || config.manual !== this.config.manual
		const keyChanged = secrets?.networkKey !== this.secrets.networkKey
		this.config = deviceChanged ? { ...config, documentId: '' } : config
		this.secrets = { networkKey: secrets?.networkKey ?? '' }
		if (deviceChanged || keyChanged) this.keyedHostIndex = 0
		// Keep the monotonic session clock across connection/configuration changes.
		this.documents.clear()
		this.setPlaybackState('stopped')
		if (deviceChanged) this.saveConfig(this.config)
		this.disconnect()
		this.connect()
		if (!keyChanged && !this.networkKey()) await this.refreshDocuments()
	}

	public getConfigFields(): SomeCompanionConfigField[] {
		const deviceChoices = [{ id: '', label: 'Searching for Teleprompters…' }]
		for (const device of [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name)))
			deviceChoices.push({ id: device.id, label: this.deviceLabel(device) })
		const selectedDevice = this.devices.get(this.config.deviceId)
		const documentPlaceholder = selectedDevice && selectedDevice.challenge === selectedDevice.id
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
		if (resolvedAddresses.length === 0 || !service.port) return
		const localAddresses = new Set(
			Object.values(networkInterfaces())
				.flat()
				.flatMap((entry) => (entry ? [entry.address] : [])),
		)
		// Bonjour resolves a local service through every active NIC. Loopback is
		// reliable and avoids guessing between Wi-Fi, Thunderbolt, and USB NICs.
		const isThisComputer = resolvedAddresses.some((address) => localAddresses.has(address))
		const hosts = isThisComputer
			? [...new Set(['::1', '127.0.0.1', ...resolvedAddresses])]
			: [...resolvedAddresses].sort((a, b) => this.addressPreference(a) - this.addressPreference(b))
		const host = hosts[0]
		const txt = service.txt as Record<string, unknown> | undefined
		const name = this.txtString(txt?.hostname) ?? this.txtString(txt?.name) ?? previous?.name ?? service.name
		const challenge = this.txtString(txt?.challenge)
		this.devices.set(id, { id, name, host, hosts, port: service.port, challenge })
		if (!this.config.manual && !this.config.deviceId && this.devices.size === 1) {
			this.config = { ...this.config, deviceId: id }
			this.saveConfig(this.config)
			this.log('info', `Automatically selected the only available Teleprompter: ${name}`)
			this.connect()
		} else if (!this.config.manual && this.config.deviceId === id && !this.socket) this.connect()
	}
	private networkKey(): string { return this.secrets.networkKey.trim() }
	private deviceLabel(device: TeleprompterDevice): string {
		if (device.challenge === device.id) return `(No Network Key) ${device.name}`
		return this.hasDifferentKey(device) ? `(Different Network Key) ${device.name}` : device.name
	}
	private addressPreference(address: string): number {
		// IPv4 is routable without interface metadata. IPv6 link-local addresses
		// require a scope ID (for example `%en0`), which Bonjour's JS resolver does
		// not expose, so leave them as a last-resort fallback.
		if (net.isIP(address) === 4) return 0
		if (net.isIP(address) === 6 && !address.toLowerCase().startsWith('fe80:')) return 1
		return 2
	}
	private hasDifferentKey(device: TeleprompterDevice): boolean {
		const key = this.networkKey()
		if (!device.challenge) return false
		if (!key) return device.challenge !== device.id
		const material = pbkdf2Sync(key, device.id, 4096, 32, 'sha256')
		const expected = createHash('sha256').update(material).digest('base64')
		return device.challenge !== expected
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
				callback: async () => this.runReset(),
			},
			set_speed: {
				name: 'Set manual speed',
				options: [{ id: 'speed', type: 'number', label: 'Speed', default: 100, min: 0, max: 1000 }],
				callback: async (event) =>
					this.send(speedMutation(this.documentId(), Number(event.options.speed), this.nextSequence())),
			},
			speed_up_5: { name: 'Increase speed by 5%', options: [], callback: async () => this.adjustSpeed(5) },
			speed_up_1: { name: 'Increase speed by 1%', options: [], callback: async () => this.adjustSpeed(1) },
			speed_down_5: { name: 'Decrease speed by 5%', options: [], callback: async () => this.adjustSpeed(-5) },
			speed_down_1: { name: 'Decrease speed by 1%', options: [], callback: async () => this.adjustSpeed(-1) },
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
		}
	}
	private getVariables(): CompanionVariableDefinitions<VariableSchema> {
		return {
			playback_state: { name: 'Playback state (Playing, Paused, or Reverse)' },
			scroll_speed: { name: 'Current scroll speed' },
		}
	}
	private getPresetStructure(): CompanionPresetSection<ModuleSchema>[] {
		return [
			{ id: 'transport', name: 'Transport', definitions: ['play_pause_toggle', 'reverse', 'stop_reset'] },
			{
				id: 'speed',
				name: 'Speed',
				definitions: ['speed_indicator', 'speed_up_5', 'speed_up_1', 'speed_down_5', 'speed_down_1'],
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
					bgcolor: 0x8b0000,
				},
				steps: [{ down: [{ actionId: 'stop_reset', options: {} }], up: [] }],
				feedbacks: [],
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
				style: { text: '$(pavonine-teleprompter:scroll_speed)', size: '24', color: 0xffffff, bgcolor: 0x202020 },
				steps: [{ down: [], up: [] }],
				feedbacks: [],
			},
			speed_up_5: this.speedPreset('Increase speed by 5%', '⌃⌃', 'speed_up_5'),
			speed_up_1: this.speedPreset('Increase speed by 1%', '⌃', 'speed_up_1'),
			speed_down_5: this.speedPreset('Decrease speed by 5%', '⌄⌄', 'speed_down_5'),
			speed_down_1: this.speedPreset('Decrease speed by 1%', '⌄', 'speed_down_1'),
		}
	}
	private speedPreset(name: string, text: string, actionId: 'speed_up_5' | 'speed_up_1' | 'speed_down_5' | 'speed_down_1') {
		return {
			type: 'simple' as const,
			name,
			keywords: ['speed', 'transport'],
			style: { text, size: '24' as const, color: 0xffffff, bgcolor: 0x202020 },
			steps: [{ down: [{ actionId, options: {} }], up: [] }],
			feedbacks: [],
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
		this.log('info', `Connecting to ${this.config.deviceId || 'no selected device'}; network key present: ${this.networkKey() ? 'yes' : 'no'}`)
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
			const device = this.devices.get(this.config.deviceId)
			if (!device) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'A discovered Teleprompter device is required when using a network key')
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
		this.log('info', `Launching keyed transport to ${endpoint.host}:${endpoint.port}`)
		const psk = pbkdf2Sync(this.networkKey(), device.id, 4096, 32, 'sha256').toString('hex')
		const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
		const addonPath = existsSync(path.join(moduleDirectory, 'teleprompter-tls-addon.node'))
			? path.join(moduleDirectory, 'teleprompter-tls-addon.node')
			: path.join(moduleDirectory, 'companion', 'teleprompter-tls-addon.node')
		try {
			const addon = nodeRequire(addonPath) as NativeTlsAddon
			this.bridge = addon.start(endpoint.host, String(endpoint.port), Buffer.from(psk, 'hex'), () => {
				this.log('info', 'Keyed Teleprompter transport authenticated')
				this.connected()
			}, (data) => {
				if (!this.keyedDataReceived) {
					this.keyedDataReceived = true
					this.log('info', `Received ${data.length} bytes of encrypted Teleprompter state`)
				}
				this.receive(data)
			}, (message) => {
				this.log('warn', `Keyed transport error: ${message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Keyed connection failed')
			})
		} catch (error) {
			const message = (error as Error).message
			this.log('error', `Unable to load keyed transport: ${message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `Unable to start keyed transport: ${message}`)
		}
	}
	private connected(): void {
		this.updateStatus(InstanceStatus.Ok, 'Discovering documents')
		this.noDocumentTimer = setTimeout(() => {
			if (this.documents.size === 0 && (this.socket || this.bridge))
				this.updateStatus(InstanceStatus.UnknownWarning, 'Connected, but Teleprompter has not sent its document list')
		}, 5000)
		if (!this.networkKey()) this.scheduleDocumentRefresh()
	}
	private disconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
		if (this.documentRefreshTimer) clearTimeout(this.documentRefreshTimer)
		this.reconnectTimer = undefined
		this.noDocumentTimer = undefined
		this.documentRefreshTimer = undefined
		this.socket?.destroy()
		this.socket = undefined
		this.bridge = undefined
		this.receiveBuffer = Buffer.alloc(0)
	}
	private scheduleReconnect(): void {
		if (this.reconnectTimer) return
		this.updateStatus(InstanceStatus.ConnectionFailure, 'Connection closed; retrying')
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
		if (this.networkKey()) return this.documents.size > 0
		const endpoint = this.endpoint()
		if (!endpoint || this.destroyed) return false
		return new Promise<boolean>((resolve) => {
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
					const length = buffer.readBigUInt64LE()
					if (length > BigInt(Number.MAX_SAFE_INTEGER)) return finish()
					const end = 8 + Number(length)
					if (buffer.length < end) return
					const payload = buffer.subarray(8, end)
					buffer = buffer.subarray(end)
					if (payload.length === 0) continue
					try {
						const message = JSON.parse(payload.toString('utf8'))
						this.observeSequence(message)
						const documents = this.snapshotDocuments(message)
						if (documents.size > 0) {
							this.replaceDocuments(documents)
							return finish(true)
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
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, data])
		while (this.receiveBuffer.length >= 8) {
			const length = this.receiveBuffer.readBigUInt64LE()
			if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
				this.log('warn', 'Ignoring an impossibly large Teleprompter frame')
				this.disconnect()
				return
			}
			const end = 8 + Number(length)
			if (this.receiveBuffer.length < end) return
			const payload = this.receiveBuffer.subarray(8, end)
			this.receiveBuffer = this.receiveBuffer.subarray(end)
			if (payload.length === 0) continue
			try {
				const message = JSON.parse(payload.toString('utf8'))
				this.observeSequence(message)
				this.readDocuments(message)
			} catch {
				this.log('warn', 'Received a non-JSON Teleprompter frame')
			}
		}
	}
	private observeSequence(message: unknown): void {
		const visit = (node: unknown): void => {
			if (!Array.isArray(node)) return
			if (node[0] === '+' && typeof node[1] === 'number' && Number.isSafeInteger(node[1])) {
				const observed = BigInt(node[1])
				if (observed >= this.sequence) this.sequence = observed + 1n
			}
			for (const child of node) visit(child)
		}
		visit(message)
	}
	private readDocuments(message: unknown): void {
		const visit = (node: unknown): void => {
			if (!Array.isArray(node)) return
			for (let index = 0; index < node.length; index += 1) {
				const value = node[index]
				if (this.isMotionPath(value)) {
					const motion = this.findTimingMotion(node[index + 1]) ?? 'stopped'
					this.documentMotions.set(value[1], motion)
					if (value[1] === this.config.documentId) this.setPlaybackState(motion, true)
				}
				if (this.isTimingValuePath(value)) {
					const type = value[4] === 'keyTime' ? 'Delta' : 'CGFloat'
					const number = this.findTypedNumber(node[index + 1], type)
					if (number !== undefined) {
						const current = this.documentTiming.get(value[1]) ?? { keyPosition: 0, keyTime: 0 }
						this.documentTiming.set(value[1], {
							...current,
							...(value[4] === 'keyTime' ? { keyTime: number } : { keyPosition: number }),
						})
					}
				}
				if (this.isManualSpeedPath(value)) {
					const speed = this.findTypedNumber(node[index + 1], 'Double')
					if (speed !== undefined) this.setDocumentSpeed(value[1], speed)
				}
				if (this.isTimerStartPath(value) && this.isUnsetValue(node[index + 1])) this.timerNeedsStart.add(value[1])
				if (this.isDocumentNamePath(value)) {
					const name = this.findStringValue(node[index + 1])
					if (name && this.documents.get(value[1]) !== name) {
						this.documents.set(value[1], name)
						if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
						this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
						this.selectOnlyDocument()
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
				if (this.noDocumentTimer) clearTimeout(this.noDocumentTimer)
				this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
				this.selectOnlyDocument()
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
						const timerInfo = model ? this.findCrdtObject(model.timerInfo) : undefined
						const speed = this.findTypedNumber(timing?.manualSpeed, 'Double')
						const keyPosition = this.findTypedNumber(timing?.keyPosition, 'CGFloat')
						const scrolledPosition = this.findTypedNumber(timing?.scrolledPosition, 'CGFloat')
						const keyTime = this.findTypedNumber(timing?.keyTime, 'Delta')
						if (keyPosition !== undefined || scrolledPosition !== undefined || keyTime !== undefined) {
							this.documentTiming.set(documentId, {
								// Stop & Reset intentionally leaves keyPosition at the old
								// anchor but moves scrolledPosition to zero. TP Controller
								// uses that visible position when starting again.
								keyPosition: scrolledPosition ?? keyPosition ?? this.documentTiming.get(documentId)?.keyPosition ?? 0,
								keyTime: keyTime ?? this.documentTiming.get(documentId)?.keyTime ?? 0,
							})
						}
						if (this.isUnsetValue(timerInfo?.timerStart)) this.timerNeedsStart.add(documentId)
						if (speed !== undefined) this.setDocumentSpeed(documentId, speed)
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
		if (this.config.documentId && !this.documents.has(this.config.documentId)) {
			this.config = { ...this.config, documentId: '' }
			this.saveConfig(this.config)
		}
		this.updateStatus(InstanceStatus.Ok, `Found ${this.documents.size} document(s)`)
		this.selectOnlyDocument()
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
	private isTimingValuePath(value: unknown): value is [string, string, string, string, 'keyPosition' | 'keyTime' | 'scrolledPosition'] {
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
	private isUnsetValue(value: unknown): boolean {
		if (!Array.isArray(value)) return false
		if (value.length === 1 && value[0] === 1) return true
		return value.some((child) => this.isUnsetValue(child))
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
	private setPlaybackState(motion: Motion, authoritative = false): void {
		// Remote mutations already include their authoritative position. Estimating
		// again here double-counts the elapsed movement and causes visible jumps.
		if (!authoritative && this.motion !== 'stopped' && motion !== this.motion) this.commitEstimatedPosition()
		if (motion !== 'stopped' && motion !== this.motion) this.playbackStartedAt = Date.now()
		if (motion === 'stopped') this.playbackStartedAt = undefined
		this.motion = motion
		this.setVariableValues({
			playback_state: motion === 'forward' ? 'Playing' : motion === 'reverse' ? 'Reverse' : 'Paused',
		})
		this.checkFeedbacks('is_playing', 'is_reverse_playing')
	}
	private setDocumentSpeed(documentId: string, speed: number): void {
		this.documentSpeeds.set(documentId, speed)
		if (documentId === this.config.documentId)
			this.setVariableValues({ scroll_speed: `${Math.round(Math.max(0, Math.min(500, speed)) / 5)}%` })
	}
	private selectOnlyDocument(): void {
		if (this.documents.size !== 1 || this.config.documentId) return
		const [documentId] = this.documents.keys()
		this.config = { ...this.config, documentId }
		this.saveConfig(this.config)
		this.setPlaybackState(this.documentMotions.get(documentId) ?? 'stopped', true)
		const speed = this.documentSpeeds.get(documentId)
		if (speed !== undefined) this.setDocumentSpeed(documentId, speed)
		this.log('info', `Automatically selected the only available document: ${this.documents.get(documentId)}`)
	}
	private documentId(): string {
		if (!this.config.documentId) throw new Error('Select a document after it has been discovered')
		return this.config.documentId.toUpperCase()
	}
	private nextSequence(): bigint {
		const now = BigInt(Date.now())
		if (now > this.sequence) this.sequence = now
		return this.sequence++
	}
	private transport(motion: Motion): { data: Buffer; documentId: string; timing: TimingState } {
		const documentId = this.documentId()
		// A fresh snapshot is authoritative when starting from a pause. While
		// already moving its position remains the starting anchor, so TP Controller
		// advances a local playhead before either Pause or a direction switch.
		const switchingDirection = this.motion !== 'stopped' && motion !== this.motion
		const position =
			motion === 'stopped' || switchingDirection
				? this.currentTiming(documentId)
				: this.documentTiming.get(documentId) ?? { keyPosition: 0, keyTime: 0 }
		// `keyTime` is a transaction timestamp, not persistent document state.
		// A fresh snapshot can contain an old multi-second/hour Delta; reusing it
		// makes Teleprompter fast-forward to catch up. TP Controller emits a new,
		// very small Delta for every command.
		const timing = { ...position, keyTime: 0.002 }
		return {
			data: transportMutation(documentId, motion, timing, this.nextSequence(), this.timerNeedsStart.has(documentId)),
			documentId,
			timing,
		}
	}
	private async runTransport(motion: Motion): Promise<void> {
		try {
			if (!(await this.refreshDocuments()))
				throw new Error('Unable to synchronize the Teleprompter position; command not sent')
			const { data, documentId, timing } = this.transport(motion)
			this.log('info', `Transport action requested: ${motion}; writing ${data.length} bytes`)
			await this.send(data)
			// `timing` already includes elapsed movement up to this button press.
			// Clear the running clock before publishing a pause so setPlaybackState
			// cannot add the same elapsed interval a second time.
			this.playbackStartedAt = undefined
			this.documentTiming.set(documentId, timing)
			if (motion === 'forward') this.timerNeedsStart.delete(documentId)
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
	private async runReset(): Promise<void> {
		const documentId = this.documentId()
		try {
			const data = resetMutation(documentId, this.nextSequence())
			this.log('info', `Stop & Reset requested; writing ${data.length} bytes`)
			await this.send(data)
			// The wire reset moves the visible scroll to zero. Mirror that locally so
			// the following Play uses zero rather than the prior pause position.
			this.playbackStartedAt = undefined
			this.documentTiming.set(documentId, { keyPosition: 0, keyTime: 0.002 })
			this.timerNeedsStart.add(documentId)
			this.setPlaybackState('stopped')
			this.log('info', 'Stop & Reset sent')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log('error', `Stop & Reset failed: ${message}`)
			throw error
		}
	}
	private async adjustSpeed(percentDelta: number): Promise<void> {
		if (!(await this.refreshDocuments())) throw new Error('Unable to synchronize the current speed; command not sent')
		const documentId = this.documentId()
		const current = this.documentSpeeds.get(documentId)
		if (current === undefined) throw new Error('Teleprompter did not provide its current speed; command not sent')
		const next = Math.max(0, Math.min(500, current + percentDelta * 5))
		await this.send(speedMutation(documentId, next, this.nextSequence()))
		this.setDocumentSpeed(documentId, next)
	}
	private currentTiming(documentId: string): TimingState {
		const timing = this.documentTiming.get(documentId) ?? { keyPosition: 0, keyTime: 0 }
		if (this.motion === 'stopped' || this.playbackStartedAt === undefined) return timing
		// TP Controller moves approximately one document point per second for
		// each manualSpeed unit (for example manualSpeed 200 measured ~200 pts/s).
		// This estimate is used only to make Pause preserve the current location.
		const direction = this.motion === 'reverse' ? -1 : 1
		const rate = this.documentSpeeds.get(documentId) ?? 100
		return {
			...timing,
			keyPosition: Math.max(0, timing.keyPosition + direction * ((Date.now() - this.playbackStartedAt) / 1000) * rate),
		}
	}
	private commitEstimatedPosition(): void {
		if (!this.config.documentId) return
		this.documentTiming.set(this.config.documentId, this.currentTiming(this.config.documentId))
	}
	private async send(data: Buffer): Promise<void> {
		if (this.bridge) {
			const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
			const addon = nodeRequire(path.join(moduleDirectory, 'companion', 'teleprompter-tls-addon.node')) as NativeTlsAddon
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
		this.disconnect()
		if (this.discoveryRefreshTimer) clearInterval(this.discoveryRefreshTimer)
		this.browser?.stop()
		this.bonjour?.destroy()
	}
}
