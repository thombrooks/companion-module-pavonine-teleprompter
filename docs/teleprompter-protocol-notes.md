# Notes on `companion-module-pavonine-teleprompter`

The Teleprompter author has authorized publication of these interoperability notes. They describe observed behavior, not an official protocol specification.

## What's exactly right

`_teleprompter3._tcp` with a dynamic port. Eight-byte little-endian length followed by UTF-8 JSON. The eight zero bytes as keepalive, sent every five seconds by both sides. The `hostname` and `challenge` TXT keys, and `challenge == service instance name` when no key is set. PBKDF2-HMAC-SHA256(key, salt = service instance name, 4096 iterations, 32 bytes), with the TLS PSK identity and the PSK both being the raw 32 bytes, `TLS_PSK_WITH_AES_128_GCM_SHA256`, and `challenge = Base64(SHA256(P))`. The tree tags (`1` null, `2` leaf, `3` deliveree leaf, `4` inode). The `merge` flag distinguishing the initial snapshot from incremental writes. And `documents/<uuid> = [1]` as a document close.

## 1. The clock components are arbitrary-precision, not 64-bit

`["+", a, b, …]` is a sign followed by **big-endian UInt64 limbs**. The captured `["+", 885, 747008163878722339]` is therefore `885·2⁶⁴ + 747008163878722339 ≈ 1.6×10²²`, a single number, not two fields.

That means `{"index":["+",sequence,index]}` with `sequence` set to epoch milliseconds is emitting roughly `sequence·2⁶⁴ ≈ 3×10³¹`. It works, but by brute force: it is about twelve orders of magnitude above anything the app itself generates, and receiving a message raises the recipient's clock to match, so the module drags the operator's own machine along with it. Nothing is corrupted on disk — documents are saved with indices erased and reloaded at a single fresh index.

The rule to mirror is `index = (max index seen anywhere on the wire) + random64` with `ammendment = 0`. Within one message, each subsequent operation keeps the _same_ index and adds a fresh random64 to `ammendment`. That is why the captured example had a nonzero ammendment: it was not the first operation in its group.

`resetMutation` currently gives both of its operations an identical index _and_ ammendment. That is harmless, because the two paths are compared independently, but it isn't what the app does.

## 2. The acceptance rule compares against the whole subtree

An incoming write is accepted when its index is strictly greater than the maximum index anywhere in the subtree being replaced — not just the index on the leaf. For leaf paths like `timing/motion` these are the same value, but the distinction matters the moment you write a subtree rather than a leaf. This is the mechanism behind stale writes disappearing without an error.

## 3. The first element is a message UUID, not an actor UUID

Receivers keep a permanent set of seen message UUIDs and silently drop repeats, so generating a fresh one per message — which you do — is required rather than stylistic. There is no actor identity on the wire; peer identity is carried implicitly by the clock.

The trailing `0` is a hop count. It is incremented on every relay, because the app is a mesh and will rebroadcast your message to its other peers. It also feeds the receiver's smoothstep transition duration, so a large value makes scroll changes visibly sluggish. Sending `0` is correct.

## 4. `keyPosition` and `keyTime` are the scroll state, not telemetry

The protocol doc says these are intentionally not emitted, but the TypeScript correctly emits them. The doc is just stale, and it's worth fixing before someone "corrects" the code to match it.

While the script is moving, position is `keyPosition + (now − keyTime) × manualSpeed`. `scrolledPosition` is consulted **only** when `motion` is null. `keyTime` serializes as seconds elapsed since the key point and is reconstructed by the receiver as `startTime = now − value`, so `0` is what the app sends.

Every timing change in the app is one atomic group: mark a key point, setting `keyPosition` to the currently evaluated position and `keyTime` to 0, then apply the change. **`speedMutation` does not do this** — it sends `manualSpeed` on its own. Because the timing function is evaluated forward from `keyTime`, changing speed mid-roll retroactively rescales every second elapsed since the last key point, and the script jumps. Wrap it the same way the transport and segment mutations are wrapped.

## 5. `selector` is missing entirely

`documents/<id>/model/timing/selector` is `[2,["Timing.Selector","manual"]]` or `[2,["Timing.Selector","timed"]]`.

When it is `timed` and a `markersTimingFunction` exists, `manualSpeed` is ignored completely — velocity comes from the marker timing function instead. A speed action in Auto mode therefore does nothing at all, which will look like a broken module to an operator. Worth reading at minimum, and ideally exposing as an action and a feedback.

## 6. Segment jumps only take effect while paused

Same root cause as item 4: `scrolledPosition` is dead state while `motion` is non-null. TP Controller's segment sheet dismisses itself the moment motion becomes non-null, which is the app conceding the same point.

Two smaller things in that section. The path is `model/timing/markersTimingFunction`, not `model.markersTimingFunction`. And it is generated during text layout, so an instance with no prompting viewport may never publish it — the segment picker needs an empty state rather than treating its absence as a parse failure.

## 7. Stop and Reset should also clear the timer

Reset sets `timerInfo/timerStart` to null. `resetMutation` never touches it, so the elapsed timer keeps its old start across a reset.

Send `documents/<id>/model/timerInfo/timerStart = [1]`. The app sets a fresh `Delta` on the next play only when the field is currently null, which makes the `startTimer` flag unnecessary — reset it and let play re-establish it.

## 8. Clamping worth replicating client-side

`scrolledPosition` is clamped to `0…maximumPosition`. `manualSpeed` is clamped at 0 from below. TP Controller clamps speed from above to `documents/<id>/model/maximumSpeed`, a `Double`. Reading that field is better than accepting arbitrary values and having them silently clamped.

## 9. The service instance UUID is regenerated on every app launch

Merging duplicate interface announcements by it is correct. Persisting a configured device by it is not: the same Mac comes back under a new UUID after a restart, so a saved configuration will point at a device that no longer exists.

## 10. Non-ASCII network keys will not interoperate

The PBKDF2 call is passed the password's grapheme-cluster count rather than its UTF-8 byte length. For `café` the app hashes four bytes (`caf\xC3`) while `Buffer.from(key, 'utf8')` gives five, so the derived PSK differs and the handshake fails.

To match, truncate the UTF-8 bytes to `[...key].length`. The salt is affected by the same quirk in principle, but it is always an ASCII UUID string, so it is unaffected in practice.

This is a bug on our end rather than an intentional design, but it is the behavior you have to reproduce today.

## 11. Framing detail

The length is read as a _signed_ `Int64`, and the reader silently re-reads the header for any frame where `length <= 0 || length >= 2³²`. That is the actual mechanism behind the keepalive: there is no ping opcode, just a zero-length frame the reader skips. It also means messages are capped at 4 GiB and anything oversized vanishes without an error rather than desynchronizing the stream.
