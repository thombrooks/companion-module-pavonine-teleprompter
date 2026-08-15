#!/bin/sh
# Mbed TLS 4.2 declares several generated C sources after its library targets.
# Make/Ninja on Unix accepts that ordering; Windows CMake generators reject it
# during configuration. Generate the exact files before adding the subproject.
set -eu

build_directory="$1"
project_directory="$(cd "$(dirname "$0")/.." && pwd)"
mbedtls_directory="$project_directory/third_party/mbedtls"
python_executable="${MBEDTLS_PYTHON:-python3}"
core_directory="$build_directory/mbedtls/tf-psa-crypto/core"
library_directory="$build_directory/mbedtls/library"
driver_error="$library_directory/tf-psa-crypto/drivers/builtin/src/error.c"

mkdir -p "$core_directory" "$(dirname "$driver_error")"
"$python_executable" "$mbedtls_directory/tf-psa-crypto/scripts/generate_driver_wrappers.py" "$core_directory"
perl "$mbedtls_directory/scripts/generate_errors.pl" \
	"$mbedtls_directory/tf-psa-crypto/drivers/builtin/include/mbedtls" \
	"$mbedtls_directory/include/mbedtls" \
	"$mbedtls_directory/scripts/data_files" \
	"$driver_error"
# The error generator's inputs cover both crypto and TLS headers, so this is
# the same complete source expected by Mbed TLS's outer library target.
cp "$driver_error" "$library_directory/error.c"
perl "$mbedtls_directory/scripts/generate_features.pl" \
	"$mbedtls_directory/include/mbedtls" \
	"$mbedtls_directory/scripts/data_files" \
	"$library_directory/version_features.c"
"$python_executable" "$mbedtls_directory/framework/scripts/generate_ssl_debug_helpers.py" \
	--mbedtls-root "$mbedtls_directory" "$library_directory"
