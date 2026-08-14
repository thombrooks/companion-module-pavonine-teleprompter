#!/bin/sh
set -eu
mkdir -p dist
swiftc scripts/teleprompter_tls_bridge.swift -O -o dist/teleprompter-tls-bridge
cp dist/teleprompter-tls-bridge companion/teleprompter-tls-bridge
