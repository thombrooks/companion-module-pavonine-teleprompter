# Historical follow-up notes, against 0.8.1 (`d99f607`)

This is the original-author comparison record, retained for its detailed
rationale. It is closed as of 0.9.0.

## Resolution status at 0.9.0

All six observations below have been addressed:

1. Explicit CRDT `timerStart` clears now remove the local show-clock value while an absent incremental field leaves it unchanged.
2. Manual elapsed time includes the first marker's configured offset.
3. Timed/Auto values derive from the marker schedule and freeze with the playhead.
4. The show-timer documentation now distinguishes manual from timed behavior and describes Total correctly.
5. Keyed refresh reconnects only when the selected document is absent, avoiding an incomplete-layout retry loop.
6. The vendored Mbed TLS 4 configuration uses PSA RNG correctly. Real-device keyed and unkeyed discovery/connection have been confirmed on Windows and Linux.

The remaining sections state the original observations, not outstanding work.

## Already resolved, for the record

The clock encoding, the message-UUID and hop-count semantics, the keypoint writes on every timing change including speed, the `selector` actions, the segment-jump gating, the `timerStart` clear inside `resetMutation`, the signed `Int64` frame header, and the grapheme-count PBKDF2 quirk are all handled correctly at HEAD. `nextSequence()` deriving from the greatest index observed on the wire is exactly the rule the app uses, and keeping the minimum position per `markerUUID` is the right way to discard the synthetic end-of-script key point that reuses the last marker's UUID. None of that needs revisiting.

## 1. The show clock's unset is no longer observed

Commit `ec05494` changed the receive path from `if (timerStart === undefined) delete; else set` to `if (timerStart !== undefined) set`. That makes an explicit clear invisible.

The app writes `documents/<id>/model/timerInfo/timerStart` to null on Stop and Reset, which arrives as `[1]` and reads back as `undefined` through the typed-number lookup. Companion therefore keeps counting Elapsed from the old start after a reset — including a reset the module itself sent, since `resetMutation` writes that same clear.

The commit message points at a real problem, so this isn't a matter of reverting. What needs separating is *absent from an incremental message*, where the previous value must stand, from *present and explicitly null*, where it must be deleted. `isUnsetValue()` in `crdt.ts` already draws that line: check whether the `timerInfo` object carries a `timerStart` key at all, delete when it does and the value is unset, set when it parses as a `Delta`, and otherwise leave the stored value alone.

## 2. Elapsed omits the script start-time offset

The app's Elapsed in manual mode is `keyPoints[0].time + (now − timerStart)`. `keyPoints[0].time` is the first marker's start time, which is user-settable and frequently not zero. `currentTimerValues()` computes `timerStart.elapsed + (Date.now() − receivedAt) / 1000` and drops the offset, so Elapsed, Total and Ahead/Behind are all displaced by it whenever a script sets one. The points array already in hand supplies the value.

## 3. Auto mode derives Elapsed from the wrong source

In `timed` mode the app does not use the show clock for Elapsed at all. It derives Elapsed from the playhead position through the marker timing function, which means Elapsed freezes whenever prompting is paused. `currentTimerValues()` uses the wall clock in both modes.

Three consequences in Auto mode. Elapsed keeps running while the playhead is parked, where the app's stops. Total drifts, where the app's is constant and equal to the last key point's time. Ahead/Behind reads progressively further behind the longer the operator holds. The value you want is the one already computed as `scheduled`; the wall clock stays correct for manual mode only.

## 4. Two corrections to the Show timers section

The claim that Elapsed continues advancing while the playhead is paused holds in manual mode only, for the reason above. In Auto mode it stops.

The claim that Total "decreases as the playhead moves forward" is inverted. While the playhead moves at the configured speed, remaining falls at one second per second and elapsed rises at the same rate, so Total holds constant — that is what makes it a projected show length rather than a countdown. It decreases only when the playhead outruns `manualSpeed`, such as during a scrub, and it rises while paused. The rest of the section is accurate, including the Ahead/Behind description and the note that the clock starts on the first forward play after Stop and Reset.

## 5. A keyed session can reconnect in a loop

`refreshDocuments()` now calls `reconnectKeyed()` whenever the selected document has no timing snapshot, on the ten-second refresh timer, and `disconnect()` clears the snapshot map on the way out. `hasFreshDocumentTimingSnapshot` is `snapshots.has(id)` and carries no freshness window despite the name.

When the selected document never yields a timing subtree the module will cycle the TLS session every ten seconds indefinitely. Two ways that happens in practice: the document is closed in the app while it stays selected in Companion, and `markersTimingFunction` is never published because the instance has no prompting viewport laying out text. A bounded number of consecutive attempts, or a reconnect conditioned on the document still being present in the document list, would contain it.

## 6. Worth verifying: the Mbed TLS RNG

The portable path never calls `mbedtls_ssl_conf_rng`, and I don't see `MBEDTLS_USE_PSA_CRYPTO` in the build configuration. `psa_crypto_init()` on its own does not wire PSA into the SSL layer's RNG in a stock Mbed TLS 3.x build, and a config without either reports `MBEDTLS_ERR_SSL_NO_RNG` (`-0x7400`) from `mbedtls_ssl_handshake`.

I have not built or run anything from the repository, so this is a question rather than a finding — but it is a quick one to settle against a real keyed handshake on Windows or Linux, and a compile-only CI run would not catch it. Everything else in that port matches the app: TLS 1.2 pinned at both ends, `MBEDTLS_TLS_PSK_WITH_AES_128_GCM_SHA256`, and identity and PSK both set to the same 32 derived bytes.
