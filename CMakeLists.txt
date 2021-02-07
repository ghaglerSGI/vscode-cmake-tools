cmake_minimum_required(VERSION 3.0.0)
project(VSCODE CMAKE TOOLS VERSION 0.1.0)

include(CTest)
enable_testing()

add_executable(VSCODE CMAKE TOOLS main.cpp)

set(CPACK_PROJECT_NAME ${tste})
set(CPACK_PROJECT_VERSION ${1.0})
include(CPack)
