import Foundation
import Network

guard CommandLine.arguments.count == 4,
	let port = UInt16(CommandLine.arguments[2]),
	let psk = Data(hex: CommandLine.arguments[3]),
	psk.count == 32
else {
	fputs("usage: psk_probe HOST PORT PSK_HEX\n", stderr)
	exit(64)
}

// This probe establishes that Network.framework can make the same TLS-PSK
// connection as TP Controller. Derive the PSK outside this diagnostic tool.
let identity = psk
let pskData = psk.withUnsafeBytes { DispatchData(bytes: $0) as __DispatchData }
let identityData = identity.withUnsafeBytes { DispatchData(bytes: $0) as __DispatchData }

let tls = NWProtocolTLS.Options()
sec_protocol_options_add_pre_shared_key(
	tls.securityProtocolOptions,
	pskData,
	identityData
)
sec_protocol_options_add_tls_ciphersuite(tls.securityProtocolOptions, 0x00a8)
let connection = NWConnection(
	host: NWEndpoint.Host(CommandLine.arguments[1]),
	port: NWEndpoint.Port(rawValue: port)!,
	using: NWParameters(tls: tls)
)
connection.stateUpdateHandler = { state in
	print(state)
	if case .ready = state { exit(0) }
	if case .failed = state { exit(1) }
}
connection.start(queue: .main)
dispatchMain()

extension Data {
	init?(hex: String) {
		guard hex.count.isMultiple(of: 2) else { return nil }
		var bytes = [UInt8]()
		for index in stride(from: 0, to: hex.count, by: 2) {
			let start = hex.index(hex.startIndex, offsetBy: index)
			let end = hex.index(start, offsetBy: 2)
			guard let byte = UInt8(hex[start..<end], radix: 16) else { return nil }
			bytes.append(byte)
		}
		self = Data(bytes)
	}
}
