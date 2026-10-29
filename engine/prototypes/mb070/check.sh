#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$root"
proto=engine/prototypes/mb070
# Refuse accidental drift in the native reference; WASM comes from this commit.
git diff --exit-code f38f4d38b86d23fb9013ce6409d02e88915a4dc2 -- engine/src engine/include
cargo test --manifest-path "$proto/Cargo.toml"
cargo build --release --manifest-path "$proto/Cargo.toml"
# Override WASM_RUSTC/WASM_CARGO when the default compiler lacks this target.
RUSTC="${WASM_RUSTC:-rustc}" "${WASM_CARGO:-cargo}" build --release --target wasm32-unknown-unknown --lib --manifest-path "$proto/Cargo.toml"
clang++ -std=c++20 -O3 -Iengine/include engine/src/physics.cpp "$proto/reference.cpp" -o "$proto/target/reference"
git show f38f4d38b86d23fb9013ce6409d02e88915a4dc2:apps/web/public/physics/voxel_physics.wasm > "$proto/target/reference.wasm"
node "$proto/parity.mjs"
