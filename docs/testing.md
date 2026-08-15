# Testing the Pavonine Teleprompter Companion module

The module uses two complementary kinds of test:

1. **Automated unit tests** protect the parts of the author-confirmed protocol that can be checked without a Teleprompter device: signed frame handling, arbitrary-precision Delta clocks, key derivation, timing evaluation, and exact CRDT mutations.
2. **Real-device rehearsal** validates the behavior that cannot be safely inferred from the protocol alone: discovery, TLS-PSK authentication, state synchronization, and what the Teleprompter application actually does with a mutation.

Neither is a substitute for the other. Teleprompter's protocol is unpublished and stateful, so successful parsing or a correctly shaped message does not prove that the application will accept it or preserve the expected playhead position.

## Automated checks

Companion's [development-environment guidance](https://companion.free/for-developers/setting-up-developer-environment/) recommends Node 22, and this module is declared as a `node22` runtime. The repository pins the currently bundled Companion Node 22 patch release in [`.node-version`](../.node-version); its scripts refuse to run under another major version.

The native TLS addon is compiled under that same Node 22 runtime. It uses the pinned `node-api-headers` package rather than a machine-specific Node installation, because Companion distributes a runtime executable but not C/C++ development headers. The addon uses stable N-API only; it does not use Node/V8 ABI-specific APIs.

The cross-platform TLS implementation vendors Mbed TLS as the pinned `third_party/mbedtls` submodule. Initialise it before building, and give Mbed TLS a Python environment containing its code-generation dependency:

```sh
git submodule update --init --recursive
python3 -m venv .venv-mbedtls
.venv-mbedtls/bin/python -m pip install -r scripts/requirements-mbedtls.txt
MBEDTLS_PYTHON="$PWD/.venv-mbedtls/bin/python" yarn build
```

The existing macOS Network.framework helper is deliberately retained for the macOS x64 prebuild. The Apple Silicon macOS, Linux, and Windows builds statically link Mbed TLS, so they do not carry a helper dylib.

`native/CMakeLists.txt` is the portable build entry point. The CI workflow builds macOS, Linux, and Windows prebuilds on every change, assembles a consolidated package, and verifies its native payload matrix. Successful compilation does not replace a keyed Teleprompter interoperability rehearsal on each target.

Install and select Node 22 with the workflow Companion recommends, then enable the pinned Yarn release:

```sh
fnm install 22
fnm use 22
fnm default 22
corepack enable
yarn install
```

Run before making a package:

```sh
yarn test
yarn check
yarn build
```

`yarn test` compiles the TypeScript source and runs Node's built-in test runner. It asserts the following wire-level invariants:

- the 8-byte little-endian **signed** frame length includes the UTF-8 byte length; zero, negative, and 4 GiB-or-larger headers are skipped as Teleprompter does;
- CRDT Deltas are compared as big-endian UInt64 limbs without IEEE-754 rounding, and each outgoing message uses one index with amendment zero followed by unique random amendments;
- Forward, Reverse, Pause, speed changes, and segment jumps establish `keyPosition` and `keyTime = 0` in the same transaction as the requested change;
- the playhead evaluator consults `scrolledPosition` only while paused, otherwise derives position from the documented timing keypoint;
- Stop & Reset stops, resets visible scroll position, and clears `timerInfo/timerStart`;
- a non-ASCII network key reproduces Teleprompter's current grapheme-count byte-truncation behavior;
- manual speed is clamped to zero and the document's advertised `maximumSpeed` when that value is known.

The tests intentionally do not assert randomized message UUID values or random amendment values. They validate their required placement and relationship while allowing each request to receive fresh randomized identifiers.

## Real-device release checklist

Use a sacrificial copy of a script, not an active production script. Keep both the Mac/iPad Teleprompter host and Companion on the intended production network.

- [ ] With no network key, the device appears once despite multiple local NICs and the document picker shows the open document.
- [ ] On macOS, with a matching network key, the device and its open document appear after authentication.
- [ ] On each supported Linux and Windows host, a matching network key authenticates successfully and at least one playback action works without a native-addon load error.
- [ ] With an intentionally wrong key, the device remains visible as **Different Network Key** and no document is offered.
- [ ] Set the playhead in the middle of the script, then test Forward → Pause → Forward. It resumes smoothly at the same place.
- [ ] From a mid-script position, test Reverse → Pause → Reverse. It resumes smoothly and does not jump toward either end.
- [ ] Test Forward directly to Reverse and Reverse directly to Forward; the selected direction takes over without a playhead jump.
- [ ] Test Stop & Reset, then Forward. It begins at the script start at normal speed.
- [ ] Test Stop & Reset confirmation: the first press flashes black/red and shows **SURE?**; a second press within three seconds resets; timeout or another Teleprompter-module action cancels without resetting.
- [ ] Test +1%, -1%, +5%, and -5% at 0%, 22%, 96%, and the document's `maximumSpeed`. Values clamp at zero and the advertised maximum; the speed indicator updates without needing another action.
- [ ] Switch the document between manual and timed selector modes. In timed mode, verify Companion reports manual speed as inactive and does not send a misleading speed command.
- [ ] While moving, attempt segment navigation. Verify Companion rejects it clearly; pause first, then verify each segment jump lands on the selected rendered keypoint.
- [ ] Verify numbered segment controls follow all four states: active + moving is dark green; active + paused is bright green; inactive + moving is gray; inactive + paused is black.
- [ ] Verify Speed / AUTO and Speed / MANUAL are a green/black radio pair. In AUTO, the speed percentage and all four manual-speed adjustments are gray; select MANUAL and verify they return to normal and alter the reported percentage.
- [ ] Confirm the Stream Deck presets' action text, icons, colors, and feedback agree with the Teleprompter state after controls are operated directly in the Teleprompter app or TP Controller.
- [ ] Restart Companion and reopen the Connections page. Confirm the selected device/document and masked key remain correct.
- [ ] For iPad hosts, wake/reopen Teleprompter and confirm a delayed Bonjour address resolution does not make the device disappear.

Record the Teleprompter and Companion versions, target architecture, and whether the device used a network key with the release notes. Do not commit packet captures or real network keys.

For a native release, confirm each expected `prebuilds/teleprompter-tls-addon-<platform>-<arch>/node-napi-v10.node` file is present. The macOS x64 package also includes its retained Network.framework helper dylib; the Mbed TLS package links its TLS implementation statically.

## When a test reveals a regression

1. Stop using the module against the live script and reproduce with a copy.
2. Capture the smallest sequence that demonstrates the problem, once through TP Controller and once through Companion.
3. Add or extend a unit test when the faulty behavior can be represented as a mutation or parser invariant.
4. Add the real-device sequence to this checklist when it depends on live application behavior.
5. Update [the protocol notes](teleprompter-protocol.md) with confirmed observations and clearly mark hypotheses or unsuccessful approaches.
