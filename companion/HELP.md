# Pavonine Teleprompter (experimental)

This module drives Pavonine Teleprompter 3 using its observed local collaborative-document protocol. It has been verified against Teleprompter 3.1.1, but it is not an official integration. Unkeyed connections use Node's TCP transport and can run wherever Companion runs. Network-key-protected connections currently require macOS (Apple Silicon or Intel), because Teleprompter requires a TLS-PSK transport with raw-byte PSK identity and the bundled helper uses Apple's Network framework.

Choose the Teleprompter from the **Teleprompter device** picker. The module reads the Bonjour record itself, collapses address variants by Teleprompter’s challenge UUID, and displays the advertised friendly name (for example, “Thom’s MacBook Air”). Teleprompter advertises its current TCP port. If Bonjour is unavailable, enable **Configure manually** and enter the host and port (the port is dynamic; check the app's advertised service rather than assuming `65330`). Do not use `127.0.0.1`: Teleprompter does not listen on its loopback address.

Setup uses two short steps because Companion refreshes configuration choices only when **Edit Connection** opens:

1. Select the Teleprompter device and click **Save**. Allow a few seconds for Save to fetch that device's document snapshot.
2. Reopen **Edit Connection**, then choose the document by filename and click **Save** again.

The module re-queries Bonjour every five seconds, keeps the friendly device name when partial Bonjour updates arrive, and follows advertised port changes. It refreshes the selected device’s snapshot every 10 seconds, so newly opened/closed documents update without a manual refresh button. With one document it selects that document automatically. No document UUID is required.

Actions: Play, Pause, **Play / Pause toggle**, Reverse, Stop and reset, and Set manual speed. The toggle uses the live motion state received from Teleprompter: it pauses when the selected document is playing, and plays when paused or reversing.

Use the `Playback state` variable in a button label to display `Playing`, `Paused`, or `Reverse`. The `Playing` boolean feedback can color a toggle button while it is playing.

The Presets tab also includes **Current document (indicator)**. It shows `READY` and the selected script name only while the module is connected and that script is still advertised by Teleprompter. If that saved document closes, it shows `CLOSED` and retains the target instead of clearing it; it automatically returns to `READY` if the same document comes back. It is deliberately an indicator, not an Open command: no observed protocol message asks a remote Teleprompter to open a script.

When the selected document sends segment markers, the **Segments** preset group adds **Current segment (indicator)**, **Jump to segment 1**, **Previous segment**, and **Next segment**. The jump preset shows the selected segment's friendly number and name and turns green from that segment's start point until the next marker's start point. To make a button for another segment, duplicate it and change its one button-local `segment_index` value; both its action and dynamic label use that value. `NO SEGMENTS` means the connected document did not transmit marker data.

The Presets tab includes a ready-made **Play / Pause toggle** button. Drag it onto a Stream Deck key to add the action, a text-based play/pause glyph, Playback state label, and Playing feedback together. Companion presets define button text, colors, actions, and feedbacks; they cannot select a Stream Deck icon family. A custom image/layered preset could be added later if a particular icon design is wanted.

The optional **Network key** is stored as a Companion secret. When it matches Teleprompter's key, the module uses the observed TLS-PSK transport; when it does not match, the device remains visible as **Different Network Key** and its documents are not offered. Clearing the field and saving returns the module to an unkeyed connection; it never changes Teleprompter's own setting.

If the connection says **Connected, but Teleprompter has not sent its document list**, the module has reached the app but has not received a usable snapshot. Reopen Edit Connection after a few seconds; do not enter a document UUID manually. For protocol details, automated checks, and the real-device release checklist, see `docs/teleprompter-protocol.md` and `docs/testing.md` in the module repository.
