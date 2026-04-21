cmake_minimum_required(VERSION 3.20)
project(FerrumProxy LANGUAGES NONE)

set(CARGO_PROFILE "release" CACHE STRING "Cargo build profile: debug or release")
find_program(CARGO_EXECUTABLE cargo)
if(NOT CARGO_EXECUTABLE AND WIN32)
  find_program(CARGO_EXECUTABLE cargo
    PATHS "$ENV{USERPROFILE}/.cargo/bin"
    NO_DEFAULT_PATH
  )
endif()
if(NOT CARGO_EXECUTABLE)
  message(FATAL_ERROR "cargo was not found. Install Rust or add %USERPROFILE%/.cargo/bin to PATH.")
endif()

if(CARGO_PROFILE STREQUAL "release")
  set(CARGO_BUILD_ARGS build --release)
  set(FERRUM_TARGET_DIR "${CMAKE_CURRENT_SOURCE_DIR}/target/release")
else()
  set(CARGO_BUILD_ARGS build)
  set(FERRUM_TARGET_DIR "${CMAKE_CURRENT_SOURCE_DIR}/target/debug")
endif()

if(WIN32)
  set(FERRUM_BINARY "${FERRUM_TARGET_DIR}/ferrum-proxy.exe")
else()
  set(FERRUM_BINARY "${FERRUM_TARGET_DIR}/ferrum-proxy")
endif()

add_custom_target(ferrum-proxy ALL
  COMMAND "${CARGO_EXECUTABLE}" ${CARGO_BUILD_ARGS}
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  BYPRODUCTS "${FERRUM_BINARY}"
  COMMENT "Building FerrumProxy with Cargo"
  VERBATIM
)
