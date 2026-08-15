#!/bin/sh
set -eu
node scripts/require-node22.mjs
node_api_header="$(node -p "require.resolve('node-api-headers/include/node_api.h')")"
node_api_include="$(dirname "$node_api_header")"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
mkdir -p "$build_dir/arm64" "$build_dir/x86_64"
swiftc -target arm64-apple-macos11 -emit-library -O scripts/teleprompter_tls_native.swift -o "$build_dir/arm64/libteleprompter_tls_native.dylib"
swiftc -target x86_64-apple-macos11 -emit-library -O scripts/teleprompter_tls_native.swift -o "$build_dir/x86_64/libteleprompter_tls_native.dylib"
lipo -create "$build_dir/arm64/libteleprompter_tls_native.dylib" "$build_dir/x86_64/libteleprompter_tls_native.dylib" -output companion/libteleprompter_tls_native.dylib
clang++ -target arm64-apple-macos11 -std=c++17 -O2 -fblocks -bundle -undefined dynamic_lookup \
	-I"$node_api_include" \
	-L"$build_dir/arm64" -lteleprompter_tls_native -Wl,-rpath,@loader_path \
	scripts/teleprompter_tls_addon.mm -o "$build_dir/arm64/teleprompter-tls-addon.node"
clang++ -target x86_64-apple-macos11 -std=c++17 -O2 -fblocks -bundle -undefined dynamic_lookup \
	-I"$node_api_include" \
	-L"$build_dir/x86_64" -lteleprompter_tls_native -Wl,-rpath,@loader_path \
	scripts/teleprompter_tls_addon.mm -o "$build_dir/x86_64/teleprompter-tls-addon.node"
lipo -create "$build_dir/arm64/teleprompter-tls-addon.node" "$build_dir/x86_64/teleprompter-tls-addon.node" -output companion/teleprompter-tls-addon.node
