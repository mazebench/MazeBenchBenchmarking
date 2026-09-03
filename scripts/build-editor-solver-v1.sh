#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
engine_tools=${MAZEBENCH_UNIT_TEST_REPO:-"$project_root/../MazeBenchEngineUnitTest"}
zig="$engine_tools/node_modules/.bin/zig"
output="$project_root/world-solver/v1/editor-solver.wasm"

if [ ! -x "$zig" ]; then
  echo "Missing Zig compiler at $zig" >&2
  exit 1
fi

mkdir -p "$project_root/.zig-cache" "$project_root/.zig-global-cache"

ZIG_LOCAL_CACHE_DIR="$project_root/.zig-cache" \
ZIG_GLOBAL_CACHE_DIR="$project_root/.zig-global-cache" \
"$zig" c++ \
  -target wasm32-freestanding \
  -std=c++20 \
  -O3 \
  -DNDEBUG \
  -flto \
  -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=physics_abi_version \
  -Wl,--export=voxel_stride \
  -Wl,--export=voxel_capacity \
  -Wl,--export=voxel_buffer \
  -Wl,--export=role_buffer_capacity \
  -Wl,--export=role_buffer \
  -Wl,--export=role_code \
  -Wl,--export=reset_command \
  -Wl,--export=step_command_tick \
  -Wl,--export=command_tick \
  -Wl,--export=command_cycle_detected \
  -Wl,--export=command_cycle_start_tick \
  -Wl,--export=command_cycle_repeat_tick \
  -Wl,--export=search_node_capacity \
  -Wl,--export=search_voxel_capacity \
  -Wl,--export=editor_solver_begin \
  -Wl,--export=editor_solver_run \
  -Wl,--export=editor_solver_status \
  -Wl,--export=editor_solver_expanded \
  -Wl,--export=editor_solver_generated \
  -Wl,--export=editor_solver_transpositions \
  -Wl,--export=editor_solver_local_expanded \
  -Wl,--export=editor_solver_command_transitions \
  -Wl,--export=editor_solver_full_physics_transitions \
  -Wl,--export=editor_solver_open_states \
  -Wl,--export=editor_solver_best_priority \
  -Wl,--export=editor_solver_node_count \
  -Wl,--export=editor_solver_maximum_nodes \
  -Wl,--export=editor_solver_node_capacity \
  -Wl,--export=editor_solver_visited_word \
  -Wl,--export=editor_solver_latest_cell \
  -Wl,--export=editor_solver_edge_count \
  -Wl,--export=editor_solver_edge_cell \
  -Wl,--export=editor_solver_edge_direction \
  -Wl,--export=editor_solver_edge_z \
  -Wl,--export=editor_solver_collected_goals \
  -Wl,--export=editor_solver_solution_interactions \
  -Wl,--export=editor_solver_solution_length \
  -Wl,--export=editor_solver_solution_step \
  -Wl,--export-memory \
  -Wl,--initial-memory=100663296 \
  -Wl,--max-memory=2147483648 \
  -o "$output" \
  -I"$project_root/engine/v1/core/include" \
  "$project_root/engine/v1/core/src/physics.cpp" \
  "$project_root/world-solver/v1/native/editor-solver-wasm.cpp"

echo "Built $output"
