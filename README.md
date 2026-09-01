# Pavonine Teleprompter Companion module

An experimental [Bitfocus Companion](https://bitfocus.io/companion) connection
module for controlling Pavonine Teleprompter 3 over the local network, much like the 
 TP Controller app does. While not written by Pavonine Software, it does have approval
 and has been reviewed by the author.

It discovers running Teleprompter instances with Bonjour, connects to the open
document, and supplies Companion actions, feedbacks, variables, and ready-made
Stream Deck presets for a prompting operator.

> This module implements an unpublished, stateful protocol. Use it with scripts
> and devices you are authorized to operate, and rehearse changes on a copy of a
> production script first.

## What it provides

- Automatic discovery of Teleprompter devices and their currently open documents.
- Plain TCP connections for devices without a network key and TLS-PSK connections
  for devices protected by one.
- Play, pause, reverse, Stop & Reset, manual-speed controls, Manual/Auto mode,
  and numbered or adjacent segment navigation.
- Feedbacks and variables for playback state, selected-document readiness,
  manual/Auto mode, speed, current segment, and show timers.
- Presets for transport, speed, segments, and timers.

Keyed and unkeyed connections have been confirmed on Mac, Windows and Linux. A
network key is stored only in Companion; this module never changes the setting in
Teleprompter.

## Getting started

1. In Teleprompter, open the script you intend to prompt and leave the
   Teleprompter application running on the same network as Companion.
2. Install the current `pavonine-teleprompter-<version>.tgz` package in
   Companion, then add a **Pavonine Teleprompter (experimental)** connection.
   The package contains the native TLS support used by keyed devices.
3. On the connection's configuration page, select the discovered Teleprompter
   device. If you enabled a network key in Teleprompter, enter the identical key
   in **Network key** and click **Save**.
4. Reopen the connection configuration after it connects, choose the open
   document, and save once more. If there is only one document, the module
   selects it automatically.
  _Note:_ It may sometimes be necessary to hit 'save' / 'done' and then return
   back to the connection before a device or document is discovered.
5. Add the supplied presets to a Companion page, or use the actions and
   feedbacks to build a layout that fits your operation.
6. _Note:_ When adding a "Jump to Segment N" button, be sure to go to the 'Local Variables'
   section and enter the segment number in the 'Current Value' under segment_index.

### Network-key behavior

- A device labelled **(No Network Key)** is intentionally contacted directly,
  even if a key remains saved from a previous device. Leave the key field alone
  and save.
- A device labelled **(Different Network Key)** needs the key that is currently
  configured in that Teleprompter instance. The module does not attempt a
  connection until the values match.
- While a keyed device reconnects, a previously selected document appears as
  **Cached document … (reconnect after Save)**. This is a valid selection, so
  changing only the network key must leave **Save** available. Its live document
  list replaces the cached entry after authentication.

## Operational notes

- **Stop & Reset** requires a second press within three seconds to avoid an
  accidental reset.
- Segment jumps only work while paused. The module deliberately prevents them while
  the script is moving.
- In **Auto** mode, Teleprompter uses marker timing; manual speed changes are
  unavailable. Switch to **Manual** mode to use the speed controls.
- If a document is closed and reopened, its internal ID can change. The module
  preserves the selected filename and reassociates it when it is unambiguous.

## Building from source

The repository includes a portable Node 22 launcher. It downloads the pinned
Node release into the ignored `.tooling/` directory, verifies its checksum, and
uses the project-pinned Yarn version. It does not alter your system Node install.

```sh
git clone --recurse-submodules https://github.com/thombrooks/companion-module-pavonine-teleprompter.git
cd companion-module-pavonine-teleprompter
python3 -m venv .venv-mbedtls
.venv-mbedtls/bin/python -m pip install -r scripts/requirements-mbedtls.txt
MBEDTLS_PYTHON="$PWD/.venv-mbedtls/bin/python" scripts/node22.sh install
MBEDTLS_PYTHON="$PWD/.venv-mbedtls/bin/python" scripts/node22.sh test
MBEDTLS_PYTHON="$PWD/.venv-mbedtls/bin/python" scripts/node22.sh package
```

The final command creates `pavonine-teleprompter-<version>.tgz` in the repository
root and retains it plus one preceding package archive.

See [the testing guide](docs/testing.md) for the full build, verification, and
real-device release checklist. The protocol constraints and confirmed behavior
are documented in [the protocol contract](docs/teleprompter-protocol.md).

## Support and status

This is experimental software. Please include the Teleprompter version,
Companion version, operating system and architecture, whether a network key was
used, and the smallest reproducible sequence when filing an
[issue](https://github.com/thombrooks/companion-module-pavonine-teleprompter/issues).
Never include a real network key or a packet capture containing production script
content.
