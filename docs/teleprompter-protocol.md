# Pavonine Teleprompter 3 protocol contract

Status: implementation contract for this module. The technical corrections supplied
by Teleprompter's author in [teleprompter-protocol-notes.md](teleprompter-protocol-notes.md)
are authoritative. Earlier packet observations are retained only where they agree
with those notes; they are not a substitute for this document.

This is an unpublished protocol. Use it only to control scripts and devices you are
authorized to operate.

## Discovery and connection

Teleprompter publishes Bonjour services of type `_teleprompter3._tcp` on a dynamic
TCP port. Its TXT records include:

- `hostname`: the friendly device name for presentation.
- `challenge`: either the service instance UUID when no network key is configured,
  or a Base64 network-key challenge.

One application instance may advertise through several interfaces. The service
instance UUID is regenerated on every app launch, so it is suitable only for
coalescing simultaneous Bonjour announcements. It must **not** be persisted as a
configured device identity.

With no key, the connection is plain TCP. With a key, it is TLS 1.2 with
`TLS_PSK_WITH_AES_128_GCM_SHA256`. Given key `K` and service instance UUID `U`:

```text
P = PBKDF2-HMAC-SHA256(password=K', salt=U, iterations=4096, outputLength=32)
challenge = Base64(SHA-256(P))
```

`K'` is a compatibility quirk: encode `K` as UTF-8, then retain only the first
`[...K].length` bytes. This intentionally reproduces the current application's
grapheme-count/byte-length mismatch for non-ASCII keys. The TLS PSK identity and
PSK are both the raw 32 bytes of `P`.

## Framing

Each frame begins with an eight-byte little-endian **signed Int64** length followed
by that many UTF-8 JSON bytes. The reader discards a header and resumes header
reading when `length <= 0` or `length >= 2^32`. Eight zero bytes are therefore the
keepalive frame; both peers send one approximately every five seconds. There is no
separate ping opcode.

## Tree messages and CRDT clocks

A payload is a JSON TreeMessage:

```json
["MESSAGE-UUID", false, [[["documents", "DOCUMENT-UUID", "…"], "VALUE"]], 0]
```

The first element is a fresh message UUID. Receivers deduplicate it permanently,
so it must never be reused. The final value is a relay hop count; Companion sends
`0`.

Tree values use the observed tags: `1` null, `2` leaf, `3` deliveree leaf, and `4`
inode. The `merge` flag distinguishes an initial snapshot from incremental writes.
`documents/<uuid> = [1]` closes a document.

Each mutation carries:

```json
{ "index": ["+", "…"], "ammendment": ["+", "…"] }
```

`["+", a, b, …]` is one signed arbitrary-precision value, represented by
big-endian UInt64 limbs. It is not an epoch/counter pair and it must not be handled
as JavaScript Numbers.

For one outbound message:

1. Find the maximum full `index` observed anywhere on the wire.
2. Set the message index to that value plus a random UInt64 value.
3. Give the first operation amendment zero.
4. Keep the same index for subsequent operations, and add a fresh random UInt64 to
   the amendment for each one.

An incoming replacement is accepted only if its index is strictly greater than the
maximum index anywhere in the subtree it replaces. The module therefore emits only
leaf writes unless a subtree write is deliberately required.

## Documents and state

Document metadata is published under `documents/<uuid>`, including
`name = [2, ["String", "filename.tp3"]]`. The module must preserve a saved document
selection when that document temporarily disappears, report it unavailable, and
resume control automatically if the same selected document is published again.

The authoritative timing state is under `documents/<uuid>/model/timing`:

- `keyPosition`: position at the timing keypoint.
- `keyTime`: elapsed seconds at serialization; reconstruct the keypoint as
  `startTime = receiveNow - keyTime`.
- `motion`: `forward`, `reverse`, or null.
- `manualSpeed`: manual velocity.
- `selector`: `manual` or `timed`.
- `markersTimingFunction`: rendered segment keypoints, when layout has published it.
- `scrolledPosition`: the paused position only.

While moving, the evaluated position is:

```text
keyPosition + (now - startTime) × manualSpeed
```

`scrolledPosition` is consulted only when `motion` is null. All values displayed in
Companion feedback must be derived from that rule, clamped to `0…maximumPosition`.

When `selector` is `timed` and `markersTimingFunction` is present, the manual speed
is ignored; marker timing determines velocity. The module must make this state
visible and must not represent an ineffective manual-speed action as a success.

## Show timers

`model/timerInfo/timerStart` establishes the show clock on the first forward play
after Stop & Reset. In manual mode, **Elapsed** begins at the first key point's
scheduled time and continues advancing while the playhead is paused, moving, or
being scrubbed. **Remaining** is derived from the current playhead position and
remains fixed while paused. **Total** is the live sum of elapsed show time and the
position-derived remaining duration. During normal forward prompting those values
change at the same rate, so Total stays constant; it changes when a scrub outruns
the configured speed and rises while paused. **Ahead / Behind** compares the
position's scheduled elapsed time with the live Elapsed show clock.

In timed (Auto) mode, Elapsed, Remaining, and Total come directly from the marker
timing function: Elapsed is the scheduled time at the playhead, Remaining is the
time to its final key point, and Total is that final key point's time. They remain
fixed while prompting is paused.

## Compliant control mutations

Every timing change is an atomic group of leaf writes. It first writes the current
evaluated position as `keyPosition` and writes `keyTime = 0`, then writes the state
being changed. This applies to forward/reverse play, pause, speed changes, and
segment navigation.

- Stop and reset writes null `motion`, zero `scrolledPosition`, and null
  `model/timerInfo/timerStart` (`[1]`). A following play establishes a fresh timer
  if required by Teleprompter.
- Speed is clamped at zero from below and at `model/maximumSpeed` from above. It
  must be written in the same keypoint group, never by itself while moving.
- Segment data is read from `model/timing/markersTimingFunction`. Its absence is a
  valid pending-layout/empty state. Segment jumps write the target
  `scrolledPosition` and only have effect while paused; controls must gate or
  clearly reject an attempted moving jump.

## Module obligations

- Never manufacture a timestamp-based CRDT index or persist a Bonjour instance UUID
  as a device identifier. Persist the friendly device name instead, and restore a
  restarted device only when exactly one same-name discovery candidate is
  compatible with the saved network key. When the selected service disappears,
  discard its cached document UUIDs while retaining the saved document name so a
  newly opened same-name document can be reassociated.
- Keep an authenticated keyed connection open while Teleprompter publishes a
  complete timing snapshot. When the selected document is absent after a file
  reopen, reconnect to obtain Teleprompter's current full document snapshot;
  reconnecting solely for an incomplete timing snapshot causes a retry loop.
- Parse the full document state before enabling position-sensitive controls.
- Keep discovery information, transport state, and document availability distinct in
  UI feedback.
- Store an optional network key locally and never alter Teleprompter's own key.
  A discovered device whose label says **(No Network Key)** deliberately uses a
  direct connection even if Companion still stores a key from an earlier device.
- Configuration must remain saveable while a protected device is reconnecting.
  Keep a saved document UUID as a valid, clearly labelled cached dropdown choice
  until its live document list replaces it; a stale document selection must never
  prevent an operator from saving a changed network key.
- Test protocol behavior with isolated or sacrificial scripts before production use.

## Historical research

Packet captures can contain script text and device/network identifiers and are not
committed. Earlier experiments and captures remain useful as test fixtures only
when they conform to this contract. See
[teleprompter-protocol-notes.md](teleprompter-protocol-notes.md) for the complete
author-provided correction record.
