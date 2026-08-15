#!/bin/sh
set -eu
node scripts/require-node22.mjs
node_api_header="$(node -p "require.resolve('node-api-headers/include/node_api.h')")"
node_api_include="$(dirname "$node_api_header")"
build_dir="$(mktemp -d)"
project_dir="$(pwd)"
mbedtls_python="${MBEDTLS_PYTHON:-python3}"
trap 'rm -rf "$build_dir"' EXIT
# Some developer installations select Command Line Tools while `swift` comes
# from a newer Xcode. Prefer the complete matching Xcode toolchain when it is
# installed, and keep compiler-module caches inside this disposable build.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
	export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi
export CLANG_MODULE_CACHE_PATH="$build_dir/clang-module-cache"
mkdir -p "$build_dir/arm64" "$build_dir/x86_64"
cmake -S "$project_dir/native" -B "$build_dir/mbedtls-arm64" \
	-DNODE_API_INCLUDE="$node_api_include" \
	-DPython3_EXECUTABLE="$mbedtls_python" \
	-DCMAKE_LIBRARY_OUTPUT_DIRECTORY="$build_dir/arm64" \
	-DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
cmake --build "$build_dir/mbedtls-arm64" --target teleprompter_tls_addon --parallel
swiftc -target x86_64-apple-macos11 -emit-library -O scripts/teleprompter_tls_native.swift \
	-Xlinker -install_name -Xlinker @rpath/libteleprompter_tls_native.dylib \
	-o "$build_dir/x86_64/libteleprompter_tls_native.dylib"
clang++ -target x86_64-apple-macos11 -std=c++17 -O2 -fblocks -bundle -undefined dynamic_lookup \
	-I"$node_api_include" \
	-L"$build_dir/x86_64" -lteleprompter_tls_native -Wl,-rpath,@loader_path \
	scripts/teleprompter_tls_addon.cpp -o "$build_dir/x86_64/teleprompter-tls-addon.node"
# The release package includes prebuilds collected from CI for other hosts.
# Refresh only the two macOS directories; never discard Windows/Linux files.
rm -rf prebuilds/teleprompter-tls-addon-darwin-arm64 prebuilds/teleprompter-tls-addon-darwin-x64
"$project_dir/node_modules/.bin/pkg-prebuilds-copy" --baseDir "$build_dir/arm64" --source teleprompter-tls-addon.node --name teleprompter-tls-addon --napi_version 10 --platform darwin --arch arm64
"$project_dir/node_modules/.bin/pkg-prebuilds-copy" --baseDir "$build_dir/x86_64" --source teleprompter-tls-addon.node --name teleprompter-tls-addon --napi_version 10 --platform darwin --arch x64 --extraFiles libteleprompter_tls_native.dylib
