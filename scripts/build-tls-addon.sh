#!/bin/sh
set -eu
swiftc -emit-library -O scripts/teleprompter_tls_native.swift -o companion/libteleprompter_tls_native.dylib
clang++ -std=c++17 -O2 -fblocks -bundle -undefined dynamic_lookup \
	-I/opt/homebrew/Cellar/node/26.7.0/include/node \
	-Lcompanion -lteleprompter_tls_native -Wl,-rpath,@loader_path \
	scripts/teleprompter_tls_addon.mm -o companion/teleprompter-tls-addon.node
