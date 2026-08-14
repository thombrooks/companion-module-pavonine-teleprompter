#!/bin/sh
set -eu
node scripts/require-node22.mjs
node_api_header="$(node -p "require.resolve('node-api-headers/include/node_api.h')")"
node_api_include="$(dirname "$node_api_header")"
swiftc -emit-library -O scripts/teleprompter_tls_native.swift -o companion/libteleprompter_tls_native.dylib
clang++ -std=c++17 -O2 -fblocks -bundle -undefined dynamic_lookup \
	-I"$node_api_include" \
	-Lcompanion -lteleprompter_tls_native -Wl,-rpath,@loader_path \
	scripts/teleprompter_tls_addon.mm -o companion/teleprompter-tls-addon.node
