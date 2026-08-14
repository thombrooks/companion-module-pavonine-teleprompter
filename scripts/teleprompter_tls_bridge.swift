import Foundation
import Network

guard CommandLine.arguments.count == 4,
	let port = UInt16(CommandLine.arguments[2]),
	let psk = Data(hex: CommandLine.arguments[3]),
	psk.count == 32
else {
	fputs("usage: teleprompter-tls-bridge HOST PORT PSK_HEX\n", stderr)
	exit(64)
}

let tls = NWProtocolTLS.Options()
let pskData = psk.withUnsafeBytes { DispatchData(bytes: $0) as __DispatchData }
// Teleprompter uses the same 32-byte PBKDF2 result as both PSK and identity.
sec_protocol_options_add_pre_shared_key(tls.securityProtocolOptions, pskData, pskData)
sec_protocol_options_add_tls_ciphersuite(tls.securityProtocolOptions, 0x00a8)

let hostText = CommandLine.arguments[1]
let host: NWEndpoint.Host
if let address = IPv4Address(hostText) {
	host = .ipv4(address)
} else if let address = IPv6Address(hostText) {
	host = .ipv6(address)
} else {
	host = .name(hostText, nil)
}
let connection = NWConnection(host: host, port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: tls))

func fail(_ message: String) -> Never {
	fputs("teleprompter TLS bridge: \(message)\n", stderr)
	exit(1)
}

func receive() {
	connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, complete, error in
		if let data, !data.isEmpty { FileHandle.standardOutput.write(data) }
		if let error { fail(error.localizedDescription) }
		if complete { exit(0) }
		receive()
	}
}

connection.stateUpdateHandler = { state in
	switch state {
	case .ready:
		fputs("READY\n", stderr)
		// The official controller emits this zero-length framed keepalive as soon
		// as it attaches. It also prompts the host to send its current snapshot.
		connection.send(content: Data(repeating: 0, count: 8), completion: .contentProcessed { error in
			if let error { fail(error.localizedDescription) }
		})
		receive()
		FileHandle.standardInput.readabilityHandler = { handle in
			let data = handle.availableData
			if data.isEmpty {
				handle.readabilityHandler = nil
				connection.cancel()
				return
			}
			connection.send(content: data, completion: .contentProcessed { error in
				if let error { fail(error.localizedDescription) }
			})
		}
	case .failed(let error): fail(error.localizedDescription)
	case .waiting(let error): fputs("WAITING: \(error.localizedDescription)\n", stderr)
	case .cancelled: exit(0)
	default: break
	}
}
connection.start(queue: .main)
dispatchMain()

extension Data {
	init?(hex: String) {
		guard hex.count.isMultiple(of: 2) else { return nil }
		var bytes = [UInt8]()
		bytes.reserveCapacity(hex.count / 2)
		for offset in stride(from: 0, to: hex.count, by: 2) {
			let start = hex.index(hex.startIndex, offsetBy: offset)
			let end = hex.index(start, offsetBy: 2)
			guard let byte = UInt8(hex[start..<end], radix: 16) else { return nil }
			bytes.append(byte)
		}
		self = Data(bytes)
	}
}
