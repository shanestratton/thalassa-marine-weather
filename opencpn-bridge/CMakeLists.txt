# ─────────────────────────────────────────────────────────────────────
#  Thalassa Bridge OpenCPN Plugin
#
#  Builds a shared library (.dylib on Mac, .so on Linux) that OpenCPN
#  loads as a plugin. The plugin starts a localhost HTTP server that
#  pi-cache calls to extract S-57 features from whatever charts
#  OpenCPN currently has loaded — including o-charts encrypted cells
#  decrypted via the user's dongle.
#
#  See README.md for prereqs + build instructions.
# ─────────────────────────────────────────────────────────────────────

cmake_minimum_required(VERSION 3.16)
project(thalassa_bridge_pi VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ── Plugin name + identifiers ─────────────────────────────────────
set(PACKAGE_NAME thalassa_bridge_pi)
set(PLUGIN_VERSION_MAJOR 0)
set(PLUGIN_VERSION_MINOR 1)
set(PLUGIN_VERSION_PATCH 0)
set(PLUGIN_API_VERSION_MAJOR 1)
set(PLUGIN_API_VERSION_MINOR 19)

# ── OpenCPN plugin SDK location ───────────────────────────────────
# The user clones OpenCPN source alongside this repo (see README).
# Override OPENCPN_SOURCE_DIR if the source lives elsewhere.
set(OPENCPN_SOURCE_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/../../opencpn-source"
    CACHE PATH "Path to OpenCPN source tree (for plugin SDK headers)")

if(NOT EXISTS "${OPENCPN_SOURCE_DIR}/include/ocpn_plugin.h")
    message(FATAL_ERROR
        "OpenCPN plugin SDK headers not found at ${OPENCPN_SOURCE_DIR}/include/ocpn_plugin.h\n"
        "Clone OpenCPN source: git clone https://github.com/OpenCPN/OpenCPN.git ${OPENCPN_SOURCE_DIR}\n"
        "Or pass -DOPENCPN_SOURCE_DIR=/path/to/opencpn-source to cmake.")
endif()

# ── wxWidgets (required by the plugin SDK) ────────────────────────
find_package(wxWidgets REQUIRED COMPONENTS core base)
include(${wxWidgets_USE_FILE})

# ── Sources ───────────────────────────────────────────────────────
set(PLUGIN_SOURCES
    src/thalassa_bridge_pi.cpp
    src/http_server.cpp
    src/feature_extractor.cpp
)

set(PLUGIN_HEADERS
    src/thalassa_bridge_pi.h
    src/http_server.h
    src/feature_extractor.h
)

# ── The plugin library ────────────────────────────────────────────
add_library(${PACKAGE_NAME} SHARED ${PLUGIN_SOURCES} ${PLUGIN_HEADERS})

target_include_directories(${PACKAGE_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
    ${OPENCPN_SOURCE_DIR}/include
    ${OPENCPN_SOURCE_DIR}/libs/include
)

target_link_libraries(${PACKAGE_NAME} PRIVATE ${wxWidgets_LIBRARIES})

target_compile_definitions(${PACKAGE_NAME} PRIVATE
    PLUGIN_VERSION_MAJOR=${PLUGIN_VERSION_MAJOR}
    PLUGIN_VERSION_MINOR=${PLUGIN_VERSION_MINOR}
    PLUGIN_VERSION_PATCH=${PLUGIN_VERSION_PATCH}
    PLUGIN_API_VERSION_MAJOR=${PLUGIN_API_VERSION_MAJOR}
    PLUGIN_API_VERSION_MINOR=${PLUGIN_API_VERSION_MINOR}
)

# ── Threads for HTTP server ───────────────────────────────────────
find_package(Threads REQUIRED)
target_link_libraries(${PACKAGE_NAME} PRIVATE Threads::Threads)

# ── Output naming ─────────────────────────────────────────────────
# OpenCPN expects: libthalassa_bridge_pi.dylib (Mac) / .so (Linux)
set_target_properties(${PACKAGE_NAME} PROPERTIES
    PREFIX "lib"
    OUTPUT_NAME ${PACKAGE_NAME}
)

# Strip debug symbols on Release builds for smaller .dylib
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    if(APPLE)
        add_custom_command(TARGET ${PACKAGE_NAME} POST_BUILD
            COMMAND ${CMAKE_STRIP} -x $<TARGET_FILE:${PACKAGE_NAME}>)
    else()
        add_custom_command(TARGET ${PACKAGE_NAME} POST_BUILD
            COMMAND ${CMAKE_STRIP} $<TARGET_FILE:${PACKAGE_NAME}>)
    endif()
endif()

message(STATUS "Thalassa Bridge plugin v${PROJECT_VERSION}")
message(STATUS "  OpenCPN source:    ${OPENCPN_SOURCE_DIR}")
message(STATUS "  wxWidgets version: ${wxWidgets_VERSION}")
message(STATUS "  Build type:        ${CMAKE_BUILD_TYPE}")
