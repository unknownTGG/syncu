cmake_minimum_required(VERSION 3.16)
project(syncu_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

add_library(syncu_core STATIC
  src/fft.cpp
  src/audio.cpp
  src/sync.cpp
  src/project.cpp
  src/api.cpp
  src/server.cpp
  src/log.cpp)
target_include_directories(syncu_core PUBLIC src third_party)
target_link_libraries(syncu_core PUBLIC Threads::Threads)
if(WIN32)
  target_link_libraries(syncu_core PUBLIC ws2_32)
endif()
if(MSVC)
  target_compile_options(syncu_core PRIVATE /W3 /utf-8)
else()
  target_compile_options(syncu_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()

add_executable(syncu-engine src/cli.cpp)
target_link_libraries(syncu-engine PRIVATE syncu_core)

# A signed hybrid add-on (.uxpaddon) is a possible later transport; it needs
# Adobe's hybrid SDK and an Apple Developer ID, so v0.1 uses `serve` instead.

enable_testing()
add_test(NAME engine_tests
  COMMAND ${CMAKE_COMMAND} -E env SYNCU_ENGINE=$<TARGET_FILE:syncu-engine>
          python3 ${CMAKE_CURRENT_SOURCE_DIR}/tests/run_tests.py)
