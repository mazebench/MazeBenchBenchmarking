// Benchmark-owned extension. The canonical engine stays byte-for-byte synced;
// this translation unit wraps it and adds only the random-agent batch API.
#include "../../../engine/v1/core/src/wasm_api.cpp"

namespace {

constexpr uint32_t AgentHashRole(const char* value) {
  uint32_t hash = 2166136261u;
  for (int32_t index = 0; value[index] != '\0'; ++index) {
    hash = (hash ^ static_cast<uint8_t>(value[index])) * 16777619u;
  }
  return hash;
}

constexpr uint32_t kAgentPlayerRole = AgentHashRole("player");
constexpr uint32_t kAgentGoalRole = AgentHashRole("goal");
constexpr uint32_t kAgentFloorRole = AgentHashRole("floor");
constexpr uint32_t kAgentSolidRole = AgentHashRole("solid");
constexpr uint32_t kAgentIceRole = AgentHashRole("ice");
constexpr uint32_t kAgentIceSlopeUpRole = AgentHashRole("ice-slope-up");
constexpr uint32_t kAgentIceSlopeRightRole = AgentHashRole("ice-slope-right");
constexpr uint32_t kAgentIceSlopeDownRole = AgentHashRole("ice-slope-down");
constexpr uint32_t kAgentIceSlopeLeftRole = AgentHashRole("ice-slope-left");
constexpr int32_t kAgentTrailCapacity = 50;
constexpr int32_t kAgentVisitedWords = 2048;
constexpr int32_t kAgentRoomWords = 8;
constexpr int32_t kAgentWorldRoomCapacity = 256;
constexpr int32_t kAgentWorldVoxelCapacity = voxelbench::kVoxelCapacity * 2;

struct AgentWorldRoom {
  int32_t offset = 0;
  int32_t count = 0;
  int32_t width = 0;
  int32_t height = 0;
  int32_t dynamic_count = 0;
  int32_t player_index = -1;
  bool loaded = false;
};

voxelbench::Voxel g_agent_undo_dynamic[voxelbench::kVoxelCapacity];
voxelbench::Voxel g_agent_undo_goals[voxelbench::kVoxelCapacity];
int32_t g_agent_count = 0;
int32_t g_agent_width = 0;
int32_t g_agent_height = 0;
int32_t g_agent_dynamic_count = 0;
int32_t g_agent_player_index = -1;
int32_t g_agent_goal_count = 0;
int32_t g_agent_goal_indices[voxelbench::kVoxelCapacity];
int32_t g_agent_goal_ids[voxelbench::kVoxelCapacity];
uint32_t g_agent_seed = 1;
uint32_t g_agent_visited[kAgentVisitedWords];
int32_t g_agent_trail[kAgentTrailCapacity];
int32_t g_agent_trail_count = 0;
int32_t g_agent_trail_next = 0;
int32_t g_agent_actions = 0;
int32_t g_agent_undos = 0;
int32_t g_agent_exit_direction = -1;
int32_t g_agent_exit_kind = 0;
voxelbench::Voxel g_agent_world_voxels[kAgentWorldVoxelCapacity];
AgentWorldRoom g_agent_world_rooms[kAgentWorldRoomCapacity];
int32_t g_agent_world_voxel_count = 0;
int32_t g_agent_world_columns = 0;
int32_t g_agent_world_rows = 0;
int32_t g_agent_current_room = -1;
uint32_t g_agent_reached_rooms[kAgentRoomWords];
uint32_t g_agent_collected_goals[kAgentVisitedWords];
int32_t g_agent_collected_goal_count = 0;
int32_t g_agent_moves_since_teleport = 0;
int32_t g_agent_teleports = 0;
int32_t g_agent_last_player_x[kAgentWorldRoomCapacity];
int32_t g_agent_last_player_y[kAgentWorldRoomCapacity];

bool AgentObjectIsActive(const voxelbench::Voxel& voxel) {
  return voxel.x >= 0 && voxel.y >= 0 && voxel.x < g_agent_width &&
      voxel.y < g_agent_height && voxel.z != INT32_MIN;
}

void SaveAgentUndo() {
  for (int32_t index = 0; index < g_agent_dynamic_count; ++index) {
    g_agent_undo_dynamic[index] = g_voxels[index];
  }
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_agent_undo_goals[goal] = g_voxels[g_agent_goal_indices[goal]];
  }
}

void SaveAgentGoalUndo() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_agent_undo_goals[goal] = g_voxels[g_agent_goal_indices[goal]];
  }
}

void RestoreAgentGoalUndo() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_voxels[g_agent_goal_indices[goal]] = g_agent_undo_goals[goal];
  }
}

void RestoreAgentUndo() {
  for (int32_t index = 0; index < g_agent_dynamic_count; ++index) {
    g_voxels[index] = g_agent_undo_dynamic[index];
  }
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_voxels[g_agent_goal_indices[goal]] = g_agent_undo_goals[goal];
  }
}

uint32_t NextAgentRandomValue() {
  uint32_t value = g_agent_seed;
  value ^= value << 13u;
  value ^= value >> 17u;
  value ^= value << 5u;
  g_agent_seed = value == 0 ? 0x9e3779b9u : value;
  return g_agent_seed;
}

void RecordAgentVisit() {
  const voxelbench::Voxel& player = g_voxels[g_agent_player_index];
  if (!AgentObjectIsActive(player)) return;
  int32_t cell = player.y * g_agent_width + player.x;
  if (g_agent_current_room >= 0 && g_agent_world_columns > 0) {
    const int32_t room_column = g_agent_current_room % g_agent_world_columns;
    const int32_t room_row = g_agent_current_room / g_agent_world_columns;
    const int32_t world_width = g_agent_world_columns * g_agent_width;
    cell = (room_row * g_agent_height + player.y) * world_width +
        room_column * g_agent_width + player.x;
  }
  if (cell >= 0 && cell < kAgentVisitedWords * 32) {
    g_agent_visited[cell / 32] |= uint32_t{1} << (cell % 32);
  }
  if (g_agent_current_room >= 0) {
    g_agent_last_player_x[g_agent_current_room] = player.x;
    g_agent_last_player_y[g_agent_current_room] = player.y;
  }
  g_agent_trail[g_agent_trail_next] = cell;
  g_agent_trail_next = (g_agent_trail_next + 1) % kAgentTrailCapacity;
  if (g_agent_trail_count < kAgentTrailCapacity) ++g_agent_trail_count;
}

void RecordAgentCollectedGoals() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    const int32_t id = g_agent_goal_ids[goal];
    if (id < 0 || id >= kAgentVisitedWords * 32 ||
        AgentObjectIsActive(g_voxels[g_agent_goal_indices[goal]])) {
      continue;
    }
    const uint32_t mask = uint32_t{1} << (id % 32);
    uint32_t& word = g_agent_collected_goals[id / 32];
    if ((word & mask) == 0) {
      word |= mask;
      ++g_agent_collected_goal_count;
    }
  }
}

bool PrepareAgentScene(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count) {
  g_agent_count = count;
  g_agent_width = width;
  g_agent_height = height;
  g_agent_dynamic_count = dynamic_count;
  g_agent_player_index = -1;
  g_agent_goal_count = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (g_voxels[index].role == kAgentPlayerRole && g_agent_player_index < 0) {
      g_agent_player_index = index;
    }
    if (g_voxels[index].role == kAgentGoalRole) {
      g_agent_goal_indices[g_agent_goal_count] = index;
      g_agent_goal_ids[g_agent_goal_count] = g_voxels[index].generic_id;
      ++g_agent_goal_count;
    }
  }
  return g_agent_player_index >= 0 && g_agent_player_index < dynamic_count &&
      voxelbench::prepare_scene(
          &g_workspace, g_voxels, count, width, height, dynamic_count) &&
      voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, count, width, height);
}

void MarkAgentRoomReached(int32_t room_index) {
  if (room_index < 0 || room_index >= kAgentWorldRoomCapacity) return;
  g_agent_reached_rooms[room_index / 32] |= uint32_t{1} << (room_index % 32);
}

bool LoadAgentWorldRoom(
    int32_t room_index,
    const voxelbench::Voxel* carried_player = nullptr,
    int32_t player_x = 0,
    int32_t player_y = 0) {
  if (room_index < 0 || room_index >= kAgentWorldRoomCapacity) return false;
  const AgentWorldRoom& room = g_agent_world_rooms[room_index];
  if (!room.loaded || room.count < 1 || room.player_index < 0) return false;
  for (int32_t index = 0; index < room.count; ++index) {
    g_voxels[index] = g_agent_world_voxels[room.offset + index];
  }
  if (carried_player != nullptr) {
    g_voxels[room.player_index] = *carried_player;
    g_voxels[room.player_index].x = player_x;
    g_voxels[room.player_index].y = player_y;
  }
  g_agent_current_room = room_index;
  if (!PrepareAgentScene(
      room.count, room.width, room.height, room.dynamic_count)) {
    return false;
  }
  MarkAgentRoomReached(room_index);
  return true;
}

int32_t AgentReachedRoomCount() {
  int32_t count = 0;
  for (int32_t word = 0; word < kAgentRoomWords; ++word) {
    count += __builtin_popcount(g_agent_reached_rooms[word]);
  }
  return count;
}

bool TeleportAgentToReachedRoom() {
  const int32_t count = AgentReachedRoomCount();
  if (count < 1) return false;
  int32_t selected = static_cast<int32_t>(NextAgentRandomValue() % count);
  for (int32_t room = 0; room < kAgentWorldRoomCapacity; ++room) {
    const uint32_t mask = uint32_t{1} << (room % 32);
    if ((g_agent_reached_rooms[room / 32] & mask) == 0) continue;
    if (selected-- == 0) {
      const voxelbench::Voxel player = g_voxels[g_agent_player_index];
      return LoadAgentWorldRoom(
          room,
          &player,
          g_agent_last_player_x[room],
          g_agent_last_player_y[room]);
    }
  }
  return false;
}

// 0 needs the exact connected-world fallback, 1 is a blocked/no-op edge,
// and 2 is a simple walk onto ordinary floor in the neighboring room.
int32_t AgentSimpleWorldEdge(
    const voxelbench::Voxel& player,
    int32_t direction,
    int32_t* next_room,
    int32_t* next_x,
    int32_t* next_y) {
  if (g_agent_current_room < 0 || g_agent_world_columns < 1 ||
      g_agent_world_rows < 1) return 0;
  const int32_t column = g_agent_current_room % g_agent_world_columns;
  const int32_t row = g_agent_current_room / g_agent_world_columns;
  int32_t next_column = column;
  int32_t next_row = row;
  if (direction == 0) --next_row;
  else if (direction == 1) ++next_column;
  else if (direction == 2) ++next_row;
  else if (direction == 3) --next_column;
  if (next_column < 0 || next_column >= g_agent_world_columns ||
      next_row < 0 || next_row >= g_agent_world_rows) return 1;

  *next_room = next_row * g_agent_world_columns + next_column;
  const AgentWorldRoom& room = g_agent_world_rooms[*next_room];
  if (!room.loaded) return 1;
  *next_x = direction == 1 ? 0 : direction == 3 ? room.width - 1 : player.x;
  *next_y = direction == 2 ? 0 : direction == 0 ? room.height - 1 : player.y;
  bool floor = false;
  bool complex = false;
  for (int32_t index = 0; index < room.count; ++index) {
    const voxelbench::Voxel& voxel = g_agent_world_voxels[room.offset + index];
    if (voxel.role == kAgentPlayerRole || voxel.x != *next_x || voxel.y != *next_y) {
      continue;
    }
    if (voxel.role == kAgentFloorRole && voxel.z == player.z - 1) {
      if (floor) complex = true;
      floor = true;
    } else if (voxel.role == kAgentSolidRole && voxel.z == player.z) {
      return 1;
    } else if (voxel.z == player.z || voxel.z == player.z - 1) {
      complex = true;
    }
  }
  return floor && !complex ? 2 : 0;
}

bool AgentPlayerIsOnIce(const voxelbench::Voxel& player) {
  for (int32_t index = 0; index < g_agent_count; ++index) {
    if (index == g_agent_player_index) continue;
    const voxelbench::Voxel& voxel = g_voxels[index];
    const bool ice = voxel.role == kAgentIceRole ||
        voxel.role == kAgentIceSlopeUpRole ||
        voxel.role == kAgentIceSlopeRightRole ||
        voxel.role == kAgentIceSlopeDownRole ||
        voxel.role == kAgentIceSlopeLeftRole;
    if (ice && voxel.x == player.x && voxel.y == player.y &&
        (voxel.z == player.z || voxel.z == player.z - 1)) {
      return true;
    }
  }
  return false;
}

int32_t AgentExitKind(
    const voxelbench::Voxel& before,
    const voxelbench::Voxel& after,
    int32_t direction) {
  if (!AgentObjectIsActive(after)) return 0;
  const int32_t dx = after.x - before.x;
  const int32_t dy = after.y - before.y;
  const bool stationary = dx == 0 && dy == 0;
  if (stationary) {
    if ((direction == 0 && after.y == 0) ||
        (direction == 1 && after.x == g_agent_width - 1) ||
        (direction == 2 && after.y == g_agent_height - 1) ||
        (direction == 3 && after.x == 0)) {
      return 1;
    }
    return 0;
  }
  const bool reached_edge =
      (after.y == 0 && dx == 0 && dy < 0) ||
      (after.x == g_agent_width - 1 && dx > 0 && dy == 0) ||
      (after.y == g_agent_height - 1 && dx == 0 && dy > 0) ||
      (after.x == 0 && dx < 0 && dy == 0);
  if (!reached_edge) return 0;
  return AgentPlayerIsOnIce(after) || dx < -1 || dx > 1 || dy < -1 || dy > 1
      ? 2
      : 0;
}

}  // namespace

extern "C" {

int32_t random_world_reset(int32_t columns, int32_t rows) {
  EnsureInitialized();
  if (columns < 1 || rows < 1 || columns * rows > kAgentWorldRoomCapacity) return 0;
  g_agent_world_columns = columns;
  g_agent_world_rows = rows;
  g_agent_world_voxel_count = 0;
  g_agent_current_room = -1;
  g_agent_moves_since_teleport = 0;
  g_agent_teleports = 0;
  g_agent_collected_goal_count = 0;
  for (int32_t room = 0; room < kAgentWorldRoomCapacity; ++room) {
    g_agent_world_rooms[room] = {};
    g_agent_last_player_x[room] = 0;
    g_agent_last_player_y[room] = 0;
  }
  for (int32_t word = 0; word < kAgentRoomWords; ++word) {
    g_agent_reached_rooms[word] = 0;
  }
  for (int32_t word = 0; word < kAgentVisitedWords; ++word) {
    g_agent_collected_goals[word] = 0;
  }
  return 1;
}

int32_t random_world_add_room(
    int32_t room_index,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count,
    int32_t player_index) {
  if (room_index < 0 || room_index >= g_agent_world_columns * g_agent_world_rows ||
      count < 1 || count > voxelbench::kVoxelCapacity || width < 1 || height < 1 ||
      static_cast<int64_t>(width) * height > 256 || dynamic_count < 1 ||
      dynamic_count > count || player_index < 0 || player_index >= dynamic_count ||
      g_agent_world_voxel_count + count > kAgentWorldVoxelCapacity) {
    return 0;
  }
  AgentWorldRoom& room = g_agent_world_rooms[room_index];
  if (room.loaded) return 0;
  room = {
    g_agent_world_voxel_count,
    count,
    width,
    height,
    dynamic_count,
    player_index,
    true
  };
  for (int32_t index = 0; index < count; ++index) {
    g_agent_world_voxels[g_agent_world_voxel_count + index] = g_voxels[index];
  }
  g_agent_world_voxel_count += count;
  return 1;
}

int32_t random_world_start(int32_t room_index, uint32_t seed) {
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  if (!LoadAgentWorldRoom(room_index)) return 0;
  RecordAgentVisit();
  return 1;
}

int32_t random_world_resume(
    int32_t room_index,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count,
    uint32_t seed) {
  if (room_index < 0 || room_index >= g_agent_world_columns * g_agent_world_rows) return 0;
  g_agent_current_room = room_index;
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  if (!PrepareAgentScene(count, width, height, dynamic_count)) return 0;
  MarkAgentRoomReached(room_index);
  return 1;
}

int32_t random_agent_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count,
    uint32_t seed) {
  EnsureInitialized();
  if (count < 1 || count > voxelbench::kVoxelCapacity || width < 1 ||
      height < 1 || static_cast<int64_t>(width) * height > 256 ||
      dynamic_voxel_count < 1 || dynamic_voxel_count > count) {
    return 0;
  }
  g_agent_current_room = -1;
  if (!PrepareAgentScene(count, width, height, dynamic_voxel_count)) return 0;
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  return 1;
}

int32_t random_agent_run(int32_t maximum_actions) {
  EnsureInitialized();
  if (maximum_actions < 0 || g_agent_player_index < 0) return -1;
  for (int32_t word = 0; word < kAgentVisitedWords; ++word) g_agent_visited[word] = 0;
  g_agent_trail_count = 0;
  g_agent_trail_next = 0;
  g_agent_actions = 0;
  g_agent_undos = 0;
  g_agent_exit_direction = -1;
  g_agent_exit_kind = 0;
  RecordAgentVisit();

  for (int32_t action = 0; action < maximum_actions; ++action) {
    if (g_agent_current_room >= 0 && g_agent_moves_since_teleport >= 10'000) {
      if (!TeleportAgentToReachedRoom()) return -1;
      g_agent_moves_since_teleport = 0;
      ++g_agent_teleports;
      RecordAgentVisit();
    }
    const voxelbench::Voxel before = g_voxels[g_agent_player_index];
    SaveAgentGoalUndo();
    const int32_t direction = static_cast<int32_t>(NextAgentRandomValue() & 3u);
    int32_t result = voxelbench::try_simulate_passive_quiescent_turn(
        &g_workspace,
        g_voxels,
        g_agent_count,
        g_agent_width,
        g_agent_height,
        direction);
    bool full_undo = false;
    if (result == 0) {
      // A passive decline is transactional, so the full snapshot is only
      // needed for the uncommon command that enters the general kernel.
      SaveAgentUndo();
      full_undo = true;
      result = voxelbench::simulate_quiescent_turn(
          &g_workspace,
          g_voxels,
          g_agent_count,
          g_agent_width,
          g_agent_height,
          direction,
          true);
    }
    if (result < 0) return result;

    const voxelbench::Voxel& player = g_voxels[g_agent_player_index];
    if (!AgentObjectIsActive(player)) {
      if (full_undo) {
        RestoreAgentUndo();
      } else {
        g_voxels[g_agent_player_index] = before;
        RestoreAgentGoalUndo();
      }
      ++g_agent_actions;
      ++g_agent_undos;
      ++g_agent_moves_since_teleport;
      if (full_undo && !voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
        return -1;
      }
      continue;
    }
    const int32_t exit_kind = AgentExitKind(before, player, direction);
    if (exit_kind != 0) {
      if (full_undo) {
        RestoreAgentUndo();
      } else {
        g_voxels[g_agent_player_index] = before;
        RestoreAgentGoalUndo();
      }
      if (exit_kind == 1 && g_agent_current_room >= 0) {
        int32_t next_room = -1;
        int32_t next_x = 0;
        int32_t next_y = 0;
        const int32_t simple = AgentSimpleWorldEdge(
            before, direction, &next_room, &next_x, &next_y);
        if (simple == 1) {
          if (full_undo && !voxelbench::prepare_quiescent_snapshot(
              &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
            return -1;
          }
          ++g_agent_actions;
          ++g_agent_moves_since_teleport;
          continue;
        }
        if (simple == 2 && LoadAgentWorldRoom(next_room, &before, next_x, next_y)) {
          ++g_agent_actions;
          ++g_agent_moves_since_teleport;
          RecordAgentVisit();
          continue;
        }
      }
      g_agent_exit_direction = direction;
      g_agent_exit_kind = exit_kind;
      if (full_undo && !voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
        return -1;
      }
      return 1;
    }
    RecordAgentCollectedGoals();
    if (full_undo && !voxelbench::prepare_quiescent_snapshot(
        &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
      return -1;
    }
    ++g_agent_actions;
    ++g_agent_moves_since_teleport;
    if (player.x != before.x || player.y != before.y || player.z != before.z) {
      RecordAgentVisit();
    }
  }
  return 0;
}

int32_t random_agent_actions() { return g_agent_actions; }
int32_t random_agent_death_undos() { return g_agent_undos; }
int32_t random_agent_exit_direction() { return g_agent_exit_direction; }
int32_t random_agent_exit_kind() { return g_agent_exit_kind; }
uint32_t random_agent_seed() { return g_agent_seed; }

uint32_t random_agent_visited_word(int32_t index) {
  if (index < 0 || index >= kAgentVisitedWords) return 0;
  return g_agent_visited[index];
}

int32_t random_agent_trail_count() { return g_agent_trail_count; }

int32_t random_agent_trail_cell(int32_t index) {
  if (index < 0 || index >= g_agent_trail_count) return -1;
  const int32_t start = g_agent_trail_count < kAgentTrailCapacity
      ? 0
      : g_agent_trail_next;
  return g_agent_trail[(start + index) % kAgentTrailCapacity];
}

int32_t random_agent_current_room() { return g_agent_current_room; }

uint32_t random_agent_reached_room_word(int32_t index) {
  if (index < 0 || index >= kAgentRoomWords) return 0;
  return g_agent_reached_rooms[index];
}

uint32_t random_agent_collected_goal_word(int32_t index) {
  if (index < 0 || index >= kAgentVisitedWords) return 0;
  return g_agent_collected_goals[index];
}

int32_t random_agent_collected_goal_count() { return g_agent_collected_goal_count; }
int32_t random_agent_teleports() { return g_agent_teleports; }

void random_agent_note_external_action() {
  ++g_agent_moves_since_teleport;
}

void random_agent_mark_goal_collected(int32_t id) {
  if (id < 0 || id >= kAgentVisitedWords * 32) return;
  const uint32_t mask = uint32_t{1} << (id % 32);
  uint32_t& word = g_agent_collected_goals[id / 32];
  if ((word & mask) == 0) {
    word |= mask;
    ++g_agent_collected_goal_count;
  }
}

}  // extern "C"
