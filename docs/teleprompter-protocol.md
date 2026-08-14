# Pavonine Teleprompter 3 protocol notes

Status: experimental; observed on macOS Teleprompter 3.1.1 (build 1514) and Teleprompter Controller during a local Wi-Fi session on 2026-08-13. This is not a published or vendor-supported API.

## Scope and safety

These notes cover local control of a script you are authorized to operate. A device with network access can control a Teleprompter instance when no network key is configured, so use an isolated production VLAN and set a network key once the integration is validated.

The Companion module uses Bonjour to find Teleprompter instances and passively reads the document list after connecting. A service is merged by its UUID, not by address: one Mac can advertise the same service through Wi-Fi, Thunderbolt, USB Ethernet, and IPv6. When the resolved addresses belong to the Mac running Companion, the module prefers loopback; otherwise it prefers IPv4, then globally routable IPv6, with IPv6 link-local addresses as a last resort because Bonjour's JavaScript resolver does not provide their interface scope IDs. It does not edit scripts or retain a packet capture.

## Transport and discovery

Teleprompter uses Bonjour (`NSNetService` / `NWListener`) to advertise and discover peers, then uses plain TCP for collaboration. The observed service type is `_teleprompter3._tcp`. Its TCP port is advertised by Bonjour and is dynamic: captures observed `65330` and `65331`, so clients must use the resolved service port rather than hard-code one.

An observed service advertisement had instance UUID `EC3202A4-2424-4C20-A5C7-62567212F8E0`, friendly-name TXT record `hostname=Thom’s MacBook Air`, and a `challenge` TXT record of the same UUID when no network key was configured. Without a network key, the application uses plain TCP (not HTTP, WebSocket, OSC, or TLS).

Bonjour can send the SRV/TXT record before its A/AAAA address record, particularly when an iPad wakes onto Wi-Fi. The module must retain such a service using its advertised `.local` hostname until the numeric address arrives; discarding address-less announcements makes the iPad intermittently vanish from the picker. This was verified with a full Teleprompter instance on iPad: after resolving its IPv4 address and matching its network key, the module authenticated and discovered its document successfully.

There is an 8-byte keepalive frame containing a zero little-endian length. It is sent by both sides while the controller is attached.

The service type is `_teleprompter3._tcp`. The module uses its UUID/challenge record to merge duplicate interface announcements and its `hostname` TXT record for the device picker. Manual host/port configuration remains only as a Bonjour fallback.

## Frame format

Every message is:

| Byte range | Meaning                                     |
| ---------- | ------------------------------------------- |
| `0..7`     | Unsigned 64-bit, little-endian length `N`   |
| `8..8+N-1` | UTF-8 JSON (`CollaborativeKit` TreeMessage) |

For example, the first eight bytes of a 1022-byte message are `fe 03 00 00 00 00 00 00`.

The payload is a JSON array:

```json
[
	"ACTOR-UUID",
	false,
	[
		[
			["documents", "DOCUMENT-UUID", "model", "timing", "motion"],
			[
				1,
				[
					[2, ["Timing.Motion", "forward"]],
					{ "index": ["+", 885, 747008163878722339], "ammendment": ["+", 3000191222313920218] }
				],
				false
			]
		]
	],
	0
]
```

## Network key

With a network key set, the Bonjour service remains `_teleprompter3._tcp`, but its `challenge` TXT value changes from the service UUID to a Base64 digest. The connection is then TLS 1.2 using `TLS_PSK_WITH_AES_128_GCM_SHA256` (`0x00a8`); the CRDT frame format above is carried inside that encrypted stream.

For a UTF-8 network key `K` and Bonjour service instance UUID `U`, derive the 32-byte key material:

```text
P = PBKDF2-HMAC-SHA256(password=K, salt=U, iterations=4096, outputLength=32)
```

The TLS PSK and TLS PSK identity are both the raw bytes `P`. Bonjour advertises:

```text
challenge = Base64(SHA-256(P))
```

Node's built-in TLS client cannot emit the required arbitrary binary PSK identity. On macOS, use `Network.framework` / `sec_protocol_options_add_pre_shared_key` for keyed connections. A companion UI should store the optional key locally, filter discovery by the derived `challenge`, and reconnect whenever that field is changed or cleared. It must never attempt to alter the Teleprompter application's own network-key setting.

### Companion runtime constraint (observed)

This module can use plain TCP when no network key is configured. Its keyed transport uses a bundled macOS N-API addon backed by `Network.framework`; it authenticates and receives the full state frame, including document names. Companion's module host disables both spawned processes and native addons by default. API 1.12 provides explicit module permissions for these capabilities.

- A bundled N-API addon and its linked Swift/Network.framework library are rejected without the manifest permission, with: `Cannot load native addon because loading addons is disabled.`
- The module declares `runtime.permissions.native-addons: true` so Companion can enable this supported, prebuilt native dependency.

The addon is macOS/arm64-specific and must be distributed as a prebuilt binary. Companion documents native dependencies as supported with the appropriate permission declaration; verify the packaged module on each target architecture.

## Document discovery

After a controller connects, Teleprompter streams document metadata as normal TreeMessage mutations. A document name is recorded at:

```text
documents/<DOCUMENT-UUID>/name = [2, ["String", "filename.tp3"]]
```

The selection capture recorded `my_new_doc.tp3` at UUID `752D7CFC-A9FC-4485-81E8-35DCBCEBF9FF` (and a separate `sample.tp3` at `389C24F5-2701-4E38-A726-23B1807341D6`). The module uses these records to populate its Document picker; users should never need to copy these UUIDs.

An initial connection can instead receive a full CRDT snapshot. In that form, each document object includes sibling `name` and `uuid` CRDT values, for example `"name":[[2,["String","my_new_doc.tp3"]],…]` and `"uuid":[[2,["UUID","752D…"]],…]`. The module handles both the snapshot and incremental forms.

Closing a document is an incremental root-map unset, rather than a name change:

```text
documents/<DOCUMENT-UUID> = [1]
```

Controllers should remove that document and clear the selection if it was selected. Reopening a file can advertise it as a fresh document UUID, so retaining the old UUID causes controls to target a document that no longer exists.

The integer clock components are 64-bit values. JavaScript must serialize them as decimal literals rather than IEEE-754 numbers; the module does this with `BigInt` converted to a string before composing the JSON.

## Observed controls

All paths start with `documents/<document UUID>/model/timing`.

| User operation | Mutated property             | Observed value                      |
| -------------- | ---------------------------- | ----------------------------------- |
| Play           | `motion`                     | `[2, ["Timing.Motion", "forward"]]` |
| Pause          | `motion`                     | `[1]`                               |
| Reverse        | `motion`                     | `[2, ["Timing.Motion", "reverse"]]` |
| Set speed      | `manualSpeed`                | `[2, ["Double", N]]`                |
| Stop and reset | `motion`, `scrolledPosition` | `[1]`, `[2, ["CGFloat", 0]]`        |

During the validation sequence, moving TP Controller's speed slider generated consecutive `manualSpeed` values at 0.25/0.5-sized increments. While prompting, messages also updated `keyPosition` and `keyTime`; these are telemetry and are intentionally not emitted by the module.

## Segments

The initial document snapshot carries segment marker names and their exact rendered playhead positions. `model.markers` supplies marker UUIDs, names, durations, and `pauseBefore` (`enabled` plus a duration); `model.markersTimingFunction` supplies ordered `keyPoints` that map each marker UUID to its visible `position`. This mapping is required because a marker's text offset is not its rendered scroll coordinate.

TP Controller's **Jump to Segment**, and the full application's next/previous segment commands, do not send a marker UUID or a semantic navigation opcode. They write ordinary timing fields: retain the current `keyPosition`, set a fresh `keyTime`, and set `scrolledPosition` to the target marker key point. Segment controls must therefore parse the marker timing function, not infer coordinates from a segment name or text offset.

## CRDT behavior and limitation

The payload is a `CollaborativeKit` CRDT mutation, not a stateless command. Each update carries an actor UUID plus an `index` and `ammendment` clock. The application accepted controller changes that used a monotonically increasing index count and arbitrary 64-bit actor-clock component in the capture.

The module creates a fresh actor UUID and random clock component per mutation. The primary `index` is an app-wide, persistent controller revision rather than a value that can reliably be recovered from a document snapshot (a new document may report only a very small local index). It begins each module session from the current millisecond epoch and increments for every mutation; that safely survives a module reinstall while remaining inside JSON's exact-integer range. Starting at zero/one makes updates stale and Teleprompter silently ignores them. This still needs further real-device testing across reconnects and competing editors. It should only be used after a rehearsal with a copy of the script.

## Reproducing the capture

1. Open the intended script in Teleprompter and attach TP Controller.
2. Capture on the active interface:

   ```sh
   tshark -i en0 -f 'tcp' -w /private/tmp/teleprompter.pcapng
   ```

3. Press Play, Pause, Reverse, Stop and reset, and adjust speed one operation at a time.
4. Locate the TCP listener and stream:

   ```sh
   lsof -nP -p "$(pgrep -x Teleprompter)" -i
   tshark -r /private/tmp/teleprompter.pcapng -Y 'tcp.port == 65330 && tcp.len > 8' -T fields -e frame.time_relative -e ipv6.src -e tcp.len -e tcp.payload
   ```

5. The document UUID is the second value after `documents` in the decoded JSON. This is useful for analysis only; Companion discovers it automatically from the corresponding `name` record.

Do not commit captures: they can contain script text, document IDs, device names, and network metadata.

## Next research steps

- Verify a generated mutation from the module against a sacrificial script, one action at a time.
- Verify the prebuilt macOS native-addon transport on both local and remote Teleprompter devices.
- Add passive state parsing, feedbacks, and presets only after mutation reliability is proven.
