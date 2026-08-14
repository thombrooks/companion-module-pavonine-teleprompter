import Foundation
import Network

let serviceID = "EC3202A4-2424-4C20-A5C7-62567212F8E0"
let password = "FOOBAR"

// Filled by the caller with the protocol-derived bytes. This probe establishes
// that Network.framework can make the same TLS-PSK connection as TP Controller.
let psk = Data(hex: "42a60486dee124f47297fecea81d474e4356d07de9afbc670fba9186098a30a9")
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
let connection = NWConnection(host: "::1", port: 65424, using: NWParameters(tls: tls))
connection.stateUpdateHandler = { state in
	print(state)
	if case .ready = state { exit(0) }
	if case .failed = state { exit(1) }
}
connection.start(queue: .main)
dispatchMain()

extension Data {
	init(hex: String) {
		self = Data(stride(from: 0, to: hex.count, by: 2).map { index in
			UInt8(hex[hex.index(hex.startIndex, offsetBy: index)..<hex.index(hex.startIndex, offsetBy: index + 2)], radix: 16)!
		})
	}
}
