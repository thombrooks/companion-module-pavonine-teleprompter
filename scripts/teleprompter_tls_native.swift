import Foundation
import Network

let tlsQueue = DispatchQueue(label: "org.bitfocus.companion.teleprompter")

public typealias ReadyCallback = @convention(c) (UnsafeMutableRawPointer?) -> Void
public typealias DataCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Void
public typealias ErrorCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void

final class TLSConnection {
	let connection: NWConnection
	let context: UnsafeMutableRawPointer?
	let ready: ReadyCallback
	let data: DataCallback
	let error: ErrorCallback
	init(host: String, port: UInt16, key: Data, context: UnsafeMutableRawPointer?, ready: @escaping ReadyCallback, data: @escaping DataCallback, error: @escaping ErrorCallback) {
		self.context = context; self.ready = ready; self.data = data; self.error = error
		let tls = NWProtocolTLS.Options()
		let psk = key.withUnsafeBytes { DispatchData(bytes: $0) as __DispatchData }
		sec_protocol_options_add_pre_shared_key(tls.securityProtocolOptions, psk, psk)
		sec_protocol_options_add_tls_ciphersuite(tls.securityProtocolOptions, 0x00a8)
		self.connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: tls))
		connection.stateUpdateHandler = { [weak self] state in
			guard let self else { return }
			switch state {
			case .ready: self.ready(self.context); self.receive()
			case .failed(let e): e.localizedDescription.withCString { self.error(self.context, $0) }
			case .cancelled: "TLS connection closed".withCString { self.error(self.context, $0) }
			default: break
			}
		}
		connection.start(queue: tlsQueue)
	}
	func receive() {
		connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] value, _, complete, err in
			guard let self else { return }
			if let value { value.withUnsafeBytes { self.data(self.context, $0.bindMemory(to: UInt8.self).baseAddress, value.count) } }
			if let err { err.localizedDescription.withCString { self.error(self.context, $0) }; return }
			if !complete { self.receive() }
		}
	}
}

@_cdecl("tp_start") public func tp_start(_ host: UnsafePointer<CChar>, _ port: UInt16, _ key: UnsafePointer<UInt8>, _ keyLength: Int, _ context: UnsafeMutableRawPointer?, _ ready: @escaping ReadyCallback, _ data: @escaping DataCallback, _ error: @escaping ErrorCallback) -> UnsafeMutableRawPointer? {
	guard keyLength == 32 else { return nil }
	let box = TLSConnection(host: String(cString: host), port: port, key: Data(bytes: key, count: keyLength), context: context, ready: ready, data: data, error: error)
	return Unmanaged.passRetained(box).toOpaque()
}
@_cdecl("tp_close") public func tp_close(_ pointer: UnsafeMutableRawPointer?) { if let pointer { let box = Unmanaged<TLSConnection>.fromOpaque(pointer).takeRetainedValue(); box.connection.stateUpdateHandler = nil; box.connection.cancel() } }
@_cdecl("tp_send") public func tp_send(_ pointer: UnsafeMutableRawPointer?, _ bytes: UnsafePointer<UInt8>, _ length: Int) {
	guard let pointer else { return }
	let box = Unmanaged<TLSConnection>.fromOpaque(pointer).takeUnretainedValue()
	box.connection.send(content: Data(bytes: bytes, count: length), completion: .contentProcessed { error in
		if let error { error.localizedDescription.withCString { box.error(box.context, $0) } }
	})
}
