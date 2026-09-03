#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
engine_tools=${MAZEBENCH_UNIT_TEST_REPO:-"$project_root/../MazeBenchEngineUnitTest"}
zig="$engine_tools/node_modules/.bin/zig"
output="$project_root/world-solver/v1/random-agent.wasm"

if [ ! -x "$zig" ]; then
  echo "Missing Zig compiler at $zig" >&2
  echo "Install MazeBenchEngineUnitTest dependencies or set MAZEBENCH_UNIT_TEST_REPO." >&2
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
  -Wl,--export=motion_state_buffer \
  -Wl,--export=motion_state_size \
  -Wl,--export=reset_command \
  -Wl,--export=step_command_tick \
  -Wl,--export=command_tick \
  -Wl,--export=command_cycle_detected \
  -Wl,--export=command_cycle_start_tick \
  -Wl,--export=command_cycle_repeat_tick \
  -Wl,--export=simulate_turn \
  -Wl,--export=search_prepare_scene \
  -Wl,--export=search_prepare_quiescent_snapshot \
  -Wl,--export=search_try_passive_quiescent_turn \
  -Wl,--export=random_agent_begin \
  -Wl,--export=random_agent_run \
  -Wl,--export=random_agent_actions \
  -Wl,--export=random_agent_death_undos \
  -Wl,--export=random_agent_exit_direction \
  -Wl,--export=random_agent_exit_kind \
  -Wl,--export=random_agent_seed \
  -Wl,--export=random_agent_visited_word \
  -Wl,--export=random_agent_trail_count \
  -Wl,--export=random_agent_trail_cell \
  -Wl,--export=random_agent_current_room \
  -Wl,--export=random_agent_reached_room_word \
  -Wl,--export=random_agent_collected_goal_word \
  -Wl,--export=random_agent_collected_goal_count \
  -Wl,--export=random_agent_teleports \
  -Wl,--export=random_agent_note_external_action \
  -Wl,--export=random_agent_mark_goal_collected \
  -Wl,--export=random_world_reset \
  -Wl,--export=random_world_add_room \
  -Wl,--export=random_world_start \
  -Wl,--export=random_world_resume \
  -Wl,--export=search_node_capacity \
  -Wl,--export=search_voxel_capacity \
  -Wl,--export=search_solve \
  -Wl,--export=search_edges \
  -Wl,--export=search_edge_count \
  -Wl,--export=search_edge_solution \
  -Wl,--export=search_moves \
  -Wl,--export=search_expanded \
  -Wl,--export=search_generated \
  -Wl,--export=search_transpositions \
  -Wl,--export=search_local_expanded \
  -Wl,--export=search_command_transitions \
  -Wl,--export=search_full_physics_transitions \
  -Wl,--export=search_solution_length \
  -Wl,--export=search_solution_step \
  -Wl,--export-memory \
  -Wl,--initial-memory=100663296 \
  -Wl,--max-memory=100663296 \
  -o "$output" \
  -I"$project_root/engine/v1/core/include" \
  "$project_root/engine/v1/core/src/physics.cpp" \
  "$project_root/engine/v1/core/src/search.cpp" \
  "$project_root/world-solver/v1/native/random-agent-wasm.cpp"

echo "Built $output"
