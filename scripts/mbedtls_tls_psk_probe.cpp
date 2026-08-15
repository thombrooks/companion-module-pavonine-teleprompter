#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/psa_util.h>
#include <mbedtls/ssl.h>
#include <mbedtls/ssl_ciphersuites.h>
#include <psa/crypto.h>

#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static bool decode_hex(const char* input, std::array<unsigned char, 32>& output) {
	if (std::strlen(input) != 64) return false;
	for (size_t index = 0; index < output.size(); ++index) {
		char byte[3] = { input[index * 2], input[index * 2 + 1], 0 };
		char* end = nullptr;
		const auto value = std::strtoul(byte, &end, 16);
		if (*end != 0) return false;
		output[index] = static_cast<unsigned char>(value);
	}
	return true;
}

static void fail(const char* operation, int result) {
	char detail[256];
	mbedtls_strerror(result, detail, sizeof(detail));
	std::fprintf(stderr, "%s: %s (%d)\n", operation, detail, result);
}

int main(int argc, char** argv) {
	if (argc != 4) {
		std::fprintf(stderr, "usage: %s HOST PORT PSK_HEX_64\n", argv[0]);
		return 64;
	}
	std::array<unsigned char, 32> psk;
	if (!decode_hex(argv[3], psk)) {
		std::fputs("PSK must be exactly 32 bytes encoded as 64 hexadecimal characters\n", stderr);
		return 64;
	}

	mbedtls_net_context socket;
	mbedtls_ssl_context ssl;
	mbedtls_ssl_config config;
	mbedtls_net_init(&socket); mbedtls_ssl_init(&ssl); mbedtls_ssl_config_init(&config);
	int result = psa_crypto_init();
	if (result == 0) result = mbedtls_net_connect(&socket, argv[1], argv[2], MBEDTLS_NET_PROTO_TCP);
	if (result == 0) result = mbedtls_ssl_config_defaults(&config, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
	const int ciphersuites[] = { MBEDTLS_TLS_PSK_WITH_AES_128_GCM_SHA256, 0 };
	if (result == 0) mbedtls_ssl_conf_min_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
	if (result == 0) mbedtls_ssl_conf_max_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
	if (result == 0) mbedtls_ssl_conf_ciphersuites(&config, ciphersuites);
	// Identity and secret are deliberately the same raw 32 bytes per Teleprompter.
	if (result == 0) result = mbedtls_ssl_conf_psk(&config, psk.data(), psk.size(), psk.data(), psk.size());
	if (result == 0) result = mbedtls_ssl_setup(&ssl, &config);
	if (result == 0) mbedtls_ssl_set_bio(&ssl, &socket, mbedtls_net_send, mbedtls_net_recv, nullptr);
	while (result == 0 || result == MBEDTLS_ERR_SSL_WANT_READ || result == MBEDTLS_ERR_SSL_WANT_WRITE)
		if ((result = mbedtls_ssl_handshake(&ssl)) == 0) break;
	if (result != 0) { fail("TLS-PSK handshake", result); return 1; }
	std::printf("connected: %s / %s\n", mbedtls_ssl_get_version(&ssl), mbedtls_ssl_get_ciphersuite(&ssl));
	mbedtls_ssl_free(&ssl); mbedtls_ssl_config_free(&config); mbedtls_net_free(&socket);
	return 0;
}
