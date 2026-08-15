#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define strdup _strdup
#endif

struct Payload { uint8_t* bytes; size_t length; };
extern "C" void* tp_start(const char*, uint16_t, const uint8_t*, int, void*, void (*)(void*), void (*)(void*, const uint8_t*, int), void (*)(void*, const char*));
extern "C" void tp_close(void*);
extern "C" void tp_send(void*, const uint8_t*, int);
struct Connection {
	void* native;
	napi_threadsafe_function ready;
	napi_threadsafe_function data;
	napi_threadsafe_function error;
	bool closed = false;
};

static void call_ready(napi_env env, napi_value cb, void*, void*) {
	if (!env || !cb) return;
	napi_value global;
	napi_get_global(env, &global);
	napi_call_function(env, global, cb, 0, nullptr, nullptr);
}
static void call_data(napi_env env, napi_value cb, void*, void* value) {
	Payload* payload = static_cast<Payload*>(value);
	if (env && cb && payload) {
		napi_value global, buffer;
		void* copied;
		napi_get_global(env, &global);
		napi_create_buffer_copy(env, payload->length, payload->bytes, &copied, &buffer);
		napi_call_function(env, global, cb, 1, &buffer, nullptr);
	}
	if (payload) { free(payload->bytes); free(payload); }
}
static void call_error(napi_env env, napi_value cb, void*, void* value) {
	char* message = static_cast<char*>(value);
	if (env && cb && message) {
		napi_value global, text;
		napi_get_global(env, &global);
		napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
		napi_call_function(env, global, cb, 1, &text, nullptr);
	}
	free(message);
}
static void report_error(Connection* state, const char* message) {
	if (!state->closed) napi_call_threadsafe_function(state->error, strdup(message), napi_tsfn_nonblocking);
}
static void native_ready(void* value) { auto* state = static_cast<Connection*>(value); if (!state->closed) napi_call_threadsafe_function(state->ready, nullptr, napi_tsfn_nonblocking); }
static void native_data(void* value, const uint8_t* bytes, int length) { auto* state = static_cast<Connection*>(value); if (state->closed || !bytes || length <= 0) return; auto* payload = static_cast<Payload*>(malloc(sizeof(Payload))); payload->bytes = static_cast<uint8_t*>(malloc(length)); payload->length = length; memcpy(payload->bytes, bytes, length); napi_call_threadsafe_function(state->data, payload, napi_tsfn_nonblocking); }
static void native_error(void* value, const char* message) { report_error(static_cast<Connection*>(value), message ? message : "TLS failed"); }
static void finalizer(napi_env, void* value, void*) {
	Connection* state = static_cast<Connection*>(value);
	state->closed = true;
	tp_close(state->native);
	napi_release_threadsafe_function(state->ready, napi_tsfn_abort);
	napi_release_threadsafe_function(state->data, napi_tsfn_abort);
	napi_release_threadsafe_function(state->error, napi_tsfn_abort);
	delete state;
}
static napi_value start(napi_env env, napi_callback_info info) {
	size_t argc = 6; napi_value args[6]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
	if (argc != 6) { napi_throw_type_error(env, nullptr, "start(host, port, psk, ready, data, error)"); return nullptr; }
	char host[256], port[8]; size_t host_len, port_len; void* psk; size_t psk_len;
	napi_get_value_string_utf8(env, args[0], host, sizeof(host), &host_len);
	napi_get_value_string_utf8(env, args[1], port, sizeof(port), &port_len);
	napi_get_buffer_info(env, args[2], &psk, &psk_len);
	if (psk_len != 32) { napi_throw_range_error(env, nullptr, "PSK must be 32 bytes"); return nullptr; }
	Connection* state = new Connection();
	napi_value name; napi_create_string_utf8(env, "teleprompter TLS callback", NAPI_AUTO_LENGTH, &name);
	napi_create_threadsafe_function(env, args[3], nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_ready, &state->ready);
	napi_create_threadsafe_function(env, args[4], nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_data, &state->data);
	napi_create_threadsafe_function(env, args[5], nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_error, &state->error);
	state->native = tp_start(host, static_cast<uint16_t>(atoi(port)), static_cast<uint8_t*>(psk), static_cast<int>(psk_len), state, native_ready, native_data, native_error);
	if (!state->native) { napi_throw_error(env, nullptr, "Unable to start TLS connection"); delete state; return nullptr; }
	napi_value result; napi_create_external(env, state, finalizer, nullptr, &result); return result;
}
static napi_value send_data(napi_env env, napi_callback_info info) {
	size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
	Connection* state; void* data; size_t length;
	napi_get_value_external(env, args[0], reinterpret_cast<void**>(&state)); napi_get_buffer_info(env, args[1], &data, &length);
	if (!state->closed) tp_send(state->native, static_cast<uint8_t*>(data), static_cast<int>(length));
	napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
	napi_property_descriptor methods[] = {{"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr}, {"send", nullptr, send_data, nullptr, nullptr, nullptr, napi_default, nullptr}};
	napi_define_properties(env, exports, 2, methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
