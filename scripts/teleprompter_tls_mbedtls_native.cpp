#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/ssl_ciphersuites.h>
#include <psa/crypto.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
typedef void (*ReadyCallback)(void*);
typedef void (*DataCallback)(void*, const uint8_t*, int);
typedef void (*ErrorCallback)(void*, const char*);
}

struct MbedConnection {
	mbedtls_net_context socket;
	mbedtls_ssl_context ssl;
	mbedtls_ssl_config config;
	std::vector<uint8_t> key;
	void* context;
	ReadyCallback ready;
	DataCallback data;
	ErrorCallback error;
	std::mutex writeLock;
	std::atomic_bool closed = false;
	std::thread worker;
	MbedConnection(const uint8_t* bytes, int length, void* value, ReadyCallback onReady, DataCallback onData, ErrorCallback onError)
		: key(bytes, bytes + length), context(value), ready(onReady), data(onData), error(onError) {
		mbedtls_net_init(&socket); mbedtls_ssl_init(&ssl); mbedtls_ssl_config_init(&config);
	}
	~MbedConnection() {
		closed = true; mbedtls_net_free(&socket);
		if (worker.joinable()) worker.join();
		mbedtls_ssl_free(&ssl); mbedtls_ssl_config_free(&config);
	}
	void fail(const char* operation, int result) {
		char detail[256]; mbedtls_strerror(result, detail, sizeof(detail));
		char message[320]; snprintf(message, sizeof(message), "%s: %s (%d)", operation, detail, result);
		if (!closed) error(context, message);
	}
	void run(std::string host, uint16_t port) {
		char service[6]; snprintf(service, sizeof(service), "%u", port);
		int result = psa_crypto_init();
		if (result == 0) result = mbedtls_net_connect(&socket, host.c_str(), service, MBEDTLS_NET_PROTO_TCP);
		if (result == 0) result = mbedtls_ssl_config_defaults(&config, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
		const int suites[] = { MBEDTLS_TLS_PSK_WITH_AES_128_GCM_SHA256, 0 };
		if (result == 0) mbedtls_ssl_conf_min_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
		if (result == 0) mbedtls_ssl_conf_max_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
		if (result == 0) mbedtls_ssl_conf_ciphersuites(&config, suites);
		if (result == 0) result = mbedtls_ssl_conf_psk(&config, key.data(), key.size(), key.data(), key.size());
		if (result == 0) result = mbedtls_ssl_setup(&ssl, &config);
		if (result == 0) mbedtls_ssl_set_bio(&ssl, &socket, mbedtls_net_send, mbedtls_net_recv, nullptr);
		while (!closed && (result == 0 || result == MBEDTLS_ERR_SSL_WANT_READ || result == MBEDTLS_ERR_SSL_WANT_WRITE)) {
			result = mbedtls_ssl_handshake(&ssl); if (result == 0) break;
		}
		if (closed) return;
		if (result != 0) { fail("TLS-PSK handshake", result); return; }
		ready(context);
		uint8_t buffer[65536];
		while (!closed) {
			result = mbedtls_ssl_read(&ssl, buffer, sizeof(buffer));
			if (result > 0) data(context, buffer, result);
			else if (result != MBEDTLS_ERR_SSL_WANT_READ && result != MBEDTLS_ERR_SSL_WANT_WRITE) break;
		}
	}
};

extern "C" void* tp_start(const char* host, uint16_t port, const uint8_t* key, int keyLength, void* context, ReadyCallback ready, DataCallback data, ErrorCallback error) {
	if (!host || !key || keyLength != 32) return nullptr;
	auto* connection = new MbedConnection(key, keyLength, context, ready, data, error);
	connection->worker = std::thread([connection, hostname = std::string(host), port] { connection->run(hostname, port); });
	return connection;
}
extern "C" void tp_close(void* value) { delete static_cast<MbedConnection*>(value); }
extern "C" void tp_send(void* value, const uint8_t* bytes, int length) {
	auto* connection = static_cast<MbedConnection*>(value);
	if (!connection || connection->closed || !bytes || length <= 0) return;
	std::lock_guard<std::mutex> lock(connection->writeLock);
	int offset = 0;
	while (!connection->closed && offset < length) {
		int result = mbedtls_ssl_write(&connection->ssl, bytes + offset, length - offset);
		if (result > 0) offset += result;
		else if (result != MBEDTLS_ERR_SSL_WANT_READ && result != MBEDTLS_ERR_SSL_WANT_WRITE) { connection->fail("TLS write", result); return; }
	}
}
