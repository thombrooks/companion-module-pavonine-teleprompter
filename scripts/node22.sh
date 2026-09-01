#!/usr/bin/env sh
# Run the project's pinned Node.js and Yarn without depending on a system install.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(tr -d '\r\n' < "$project_dir/.node-version")

case "$(uname -s)" in
	Darwin) platform=darwin ;;
	Linux) platform=linux ;;
	MINGW*|MSYS*|CYGWIN*) platform=win ;;
	*) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
	arm64|aarch64) arch=arm64 ;;
	x86_64|amd64) arch=x64 ;;
	*) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

archive="node-v${version}-${platform}-${arch}"
if [ "$platform" = win ]; then extension=zip; else extension=tar.gz; fi
cache_dir="$project_dir/.tooling"
node_dir="$cache_dir/$archive"
if [ "$platform" = win ]; then node_bin="$node_dir/node.exe"; else node_bin="$node_dir/bin/node"; fi

if [ ! -x "$node_bin" ]; then
	command -v curl >/dev/null || { echo 'node22.sh requires curl' >&2; exit 1; }
	mkdir -p "$cache_dir"
	staging_dir=$(mktemp -d "$cache_dir/.node22.XXXXXX")
	cleanup() { rm -rf "$staging_dir"; }
	trap cleanup EXIT INT TERM
	base_url="https://nodejs.org/dist/v$version"
	archive_file="$archive.$extension"
	curl -fsSLo "$staging_dir/$archive_file" "$base_url/$archive_file"
	curl -fsSLo "$staging_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt"
	expected=$(awk -v file="$archive_file" '$2 == file { print $1 }' "$staging_dir/SHASUMS256.txt")
	actual=$(shasum -a 256 "$staging_dir/$archive_file" | awk '{ print $1 }')
	[ -n "$expected" ] && [ "$expected" = "$actual" ] || {
		echo "Checksum verification failed for $archive_file" >&2
		exit 1
	}
	if [ "$platform" = win ]; then
		command -v unzip >/dev/null || { echo 'node22.sh requires unzip on Windows' >&2; exit 1; }
		unzip -q "$staging_dir/$archive_file" -d "$staging_dir"
	else
		tar -xzf "$staging_dir/$archive_file" -C "$staging_dir"
	fi
	mv "$staging_dir/$archive" "$node_dir"
	trap - EXIT INT TERM
	cleanup
fi

corepack_js="$node_dir/lib/node_modules/corepack/dist/corepack.js"
if [ ! -f "$corepack_js" ]; then corepack_js="$node_dir/node_modules/corepack/dist/corepack.js"; fi
[ -f "$corepack_js" ] || { echo "Corepack is missing from $node_dir" >&2; exit 1; }

export PATH="$(dirname "$node_bin"):$PATH"
exec "$node_bin" "$corepack_js" yarn "$@"
