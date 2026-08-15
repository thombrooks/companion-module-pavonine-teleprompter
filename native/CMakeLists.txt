cmake_minimum_required(VERSION 3.20)
project(teleprompter_tls_addon LANGUAGES C CXX)

# Mbed TLS is linked statically into a dynamically loaded Node addon.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# `node-api-headers` supplies stable N-API headers without coupling a prebuild
# to a particular Node executable ABI.
set(NODE_API_INCLUDE "" CACHE PATH "Directory containing node_api.h")
if(NOT EXISTS "${NODE_API_INCLUDE}/node_api.h")
	message(FATAL_ERROR "Set NODE_API_INCLUDE to the node-api-headers/include directory")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../third_party/mbedtls" "${CMAKE_BINARY_DIR}/mbedtls")

add_library(teleprompter_tls_addon MODULE
	"${CMAKE_CURRENT_LIST_DIR}/../scripts/teleprompter_tls_addon.cpp"
	"${CMAKE_CURRENT_LIST_DIR}/../scripts/teleprompter_tls_mbedtls_native.cpp"
)
target_compile_features(teleprompter_tls_addon PRIVATE cxx_std_17)
target_include_directories(teleprompter_tls_addon PRIVATE "${NODE_API_INCLUDE}")
target_link_libraries(teleprompter_tls_addon PRIVATE mbedtls mbedx509 tfpsacrypto)
if(NOT CMAKE_LIBRARY_OUTPUT_DIRECTORY)
	set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/output")
endif()
set_target_properties(teleprompter_tls_addon PROPERTIES
	PREFIX ""
	OUTPUT_NAME "teleprompter-tls-addon"
	SUFFIX ".node"
	LIBRARY_OUTPUT_DIRECTORY "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}"
	RUNTIME_OUTPUT_DIRECTORY "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}"
)
foreach(configuration Debug Release RelWithDebInfo MinSizeRel)
	string(TOUPPER "${configuration}" configuration_upper)
	set_target_properties(teleprompter_tls_addon PROPERTIES
		LIBRARY_OUTPUT_DIRECTORY_${configuration_upper} "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}"
		RUNTIME_OUTPUT_DIRECTORY_${configuration_upper} "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}"
	)
endforeach()

if(APPLE)
	target_link_options(teleprompter_tls_addon PRIVATE "-undefined" "dynamic_lookup")
elseif(WIN32)
	target_link_libraries(teleprompter_tls_addon PRIVATE ws2_32)
elseif(UNIX)
	target_link_options(teleprompter_tls_addon PRIVATE "-Wl,--unresolved-symbols=ignore-all")
endif()
