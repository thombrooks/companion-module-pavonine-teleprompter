# Testing the Pavonine Teleprompter Companion module

The module uses two complementary kinds of test:

1. **Automated unit tests** protect the parts of the reverse-engineered protocol that can be checked without a Teleprompter device: message framing and the exact CRDT mutations made for transport, reset, and speed changes.
2. **Real-device rehearsal** validates the behavior that cannot be safely inferred from the protocol alone: discovery, TLS-PSK authentication, state synchronization, and what the Teleprompter application actually does with a mutation.

Neither is a substitute for the other. Teleprompter's protocol is unpublished and stateful, so successful parsing or a correctly shaped message does not prove that the application will accept it or preserve the expected playhead position.

## Automated checks

Companion's [development-environment guidance](https://companion.free/for-developers/setting-up-developer-environment/) recommends Node 22, and this module is declared as a `node22` runtime. The repository pins the currently bundled Companion Node 22 patch release in [`.node-version`](../.node-version); its scripts refuse to run under another major version.

The macOS TLS bridge is compiled under that same Node 22 runtime. It uses the pinned `node-api-headers` package rather than a machine-specific Node installation, because Companion distributes a runtime executable but not C/C++ development headers. The bridge uses stable N-API only; it does not use Node/V8 ABI-specific APIs.

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

- the 8-byte little-endian frame length includes the UTF-8 byte length, not JavaScript character count;
- Forward and Reverse mutations include an anchor position, anchor time, and motion in one transaction;
- the first Forward after Stop & Reset starts the timer, while ordinary resume does not;
- Pause includes both `keyPosition` and `scrolledPosition`, preventing a visible jump back to an older anchor;
- Speed changes mutate only `manualSpeed`;
- Stop & Reset uses stopped motion and visible scroll position zero.

The tests intentionally do not assert randomized actor UUIDs or CRDT clock suffixes. They validate their structural placement while allowing each request to get fresh randomized identifiers.

## Real-device release checklist

Use a sacrificial copy of a script, not an active production script. Keep both the Mac/iPad Teleprompter host and Companion on the intended production network.

- [ ] With no network key, the device appears once despite multiple local NICs and the document picker shows the open document.
- [ ] With a matching network key, the device and its open document appear after authentication.
- [ ] With an intentionally wrong key, the device remains visible as **Different Network Key** and no document is offered.
- [ ] Set the playhead in the middle of the script, then test Forward → Pause → Forward. It resumes smoothly at the same place.
- [ ] From a mid-script position, test Reverse → Pause → Reverse. It resumes smoothly and does not jump toward either end.
- [ ] Test Forward directly to Reverse and Reverse directly to Forward; the selected direction takes over without a playhead jump.
- [ ] Test Stop & Reset, then Forward. It begins at the script start at normal speed.
- [ ] Test +1%, -1%, +5%, and -5% at 0%, 22%, 96%, and 100%. Values clamp at 0% and 100%; the speed indicator updates without needing another action.
- [ ] Confirm the Stream Deck presets' action text, icons, colors, and feedback agree with the Teleprompter state after controls are operated directly in the Teleprompter app or TP Controller.
- [ ] Restart Companion and reopen the Connections page. Confirm the selected device/document and masked key remain correct.
- [ ] For iPad hosts, wake/reopen Teleprompter and confirm a delayed Bonjour address resolution does not make the device disappear.

Record the Teleprompter and Companion versions, target architecture, and whether the device used a network key with the release notes. Do not commit packet captures or real network keys.

## When a test reveals a regression

1. Stop using the module against the live script and reproduce with a copy.
2. Capture the smallest sequence that demonstrates the problem, once through TP Controller and once through Companion.
3. Add or extend a unit test when the faulty behavior can be represented as a mutation or parser invariant.
4. Add the real-device sequence to this checklist when it depends on live application behavior.
5. Update [the protocol notes](teleprompter-protocol.md) with confirmed observations and clearly mark hypotheses or unsuccessful approaches.
