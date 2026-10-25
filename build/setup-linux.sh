#!/usr/bin/env bash
set -euo pipefail

# Tooling only. Application runtime needs none of these installations.
repo="$(cd "$(dirname "$0")/.." && pwd)"
build_root="${LOCALCONF_BUILD_ROOT:-/workspace}"
tools_dir="$build_root/toolchains"
cache_dir="$build_root/localconf-build-cache"
mkdir -p "$tools_dir" "$cache_dir"

download_verified() {
  local url="$1" output="$2" expected="$3"
  if [[ ! -f "$output" ]]; then
    curl --fail --location --retry 2 "$url" --output "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status
}

download_verified \
  https://dl.google.com/go/go1.20.14.linux-amd64.tar.gz \
  "$cache_dir/go1.20.14.tar.gz" \
  ff445e48af27f93f66bd949ae060d97991c83e11289009d311f25426258f9c44
if [[ ! -x "$tools_dir/go/bin/go" ]]; then
  tar -xzf "$cache_dir/go1.20.14.tar.gz" -C "$tools_dir"
fi
"$tools_dir/go/bin/go" version | grep -F 'go1.20.14 '

download_verified \
  https://github.com/mstorsjo/llvm-mingw/releases/download/20241217/llvm-mingw-20241217-msvcrt-ubuntu-20.04-x86_64.tar.xz \
  "$cache_dir/llvm-mingw.tar.xz" \
  eb878636e95c358452e4f4c95f032d81360096d0f1cd8ab6d24d5d09ca481372
compiler="$tools_dir/llvm-mingw-20241217-msvcrt-ubuntu-20.04-x86_64/bin/x86_64-w64-mingw32-clang"
if [[ ! -x "$compiler" ]]; then
  tar -xJf "$cache_dir/llvm-mingw.tar.xz" -C "$tools_dir"
fi
export GOPATH="$build_root/.gopath" GOCACHE="$build_root/.gocache"
cd "$repo"
npm ci --ignore-scripts --no-audit --no-fund --cache "$build_root/.npm-cache"
cd src/server
"$tools_dir/go/bin/go" mod download
"$tools_dir/go/bin/go" mod verify
mkdir -p ../../artifacts
"$tools_dir/go/bin/go" build -mod=readonly -o ../../artifacts/conference-server-linux .
cd "$repo"
python3 build/package.py --go "$tools_dir/go/bin/go" --cc "$compiler"
