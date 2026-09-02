// simulate_command accepts at most one million ticks, so the history can hold
// every post-tick state in the public command horizon without evicting a
// possible first occurrence.
constexpr int32_t kCycleHistoryCapacity = 1 << 20;
constexpr int32_t kCycleHistoryMask = kCycleHistoryCapacity - 1;

struct CycleHistoryEntry {
  uint64_t hash;
  int32_t tick;
  uint32_t generation;
};

struct CommandCycleTracker {
  Voxel baseline[kVoxelCapacity];
  Voxel replay_voxels[kVoxelCapacity];
  PhysicsWorkspace replay_workspace;
  MotionState replay_state;
  CycleHistoryEntry history[kCycleHistoryCapacity];
  uint32_t generation;
  Voxel* source_voxels;
  MotionState* source_state;
  int32_t count;
  int32_t width;
  int32_t height;
  int32_t initial_direction;
  bool replay_workspace_initialized;
  bool enabled;
  bool pending_rollback;
  bool wait_for_orange_transition;
  bool orange_transition_started;
  int64_t last_orange_depth_sum;
};

#if defined(__wasm__)
CommandCycleTracker g_command_cycle_tracker{};
#else
thread_local CommandCycleTracker g_command_cycle_tracker{};
#endif

uint64_t CycleHashMix(uint64_t hash, uint32_t value) {
  hash ^= value;
  hash *= UINT64_C(1099511628211);
  hash ^= hash >> 32u;
  return hash;
}

int64_t OrangeDepthSum(const Voxel* voxels, int32_t count) {
  int64_t total = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kOrangeWallRole) {
      total += OrangeWallDepth(voxels[index]);
    }
  }
  return total;
}

uint64_t CycleStateHash(
    const Voxel* voxels,
    int32_t count,
    const MotionState* state) {
  uint64_t hash = UINT64_C(1469598103934665603);
  for (int32_t index = 0; index < count; ++index) {
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].x));
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].y));
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].z));
    hash = CycleHashMix(hash, voxels[index].role);
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].generic_id));
  }
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->phase));
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->direction));
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->player_index));
  hash = CycleHashMix(hash, state->player_gravity_armed);
  hash = CycleHashMix(hash, state->player_falling);
  hash = CycleHashMix(hash, state->reserved[0]);
  hash = CycleHashMix(hash, state->reserved[1]);
  for (int32_t index = 0; index < count; ++index) {
    const uint32_t flags = state->horizontal_momentum[index] |
        (static_cast<uint32_t>(state->falling[index]) << 8u) |
        (static_cast<uint32_t>(state->gravity_armed[index]) << 16u);
    hash = CycleHashMix(hash, flags);
  }
  return hash;
}

bool SameCycleState(
    const Voxel* left_voxels,
    const MotionState* left_state,
    const Voxel* right_voxels,
    const MotionState* right_state,
    int32_t count) {
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& left = left_voxels[index];
    const Voxel& right = right_voxels[index];
    if (left.x != right.x || left.y != right.y || left.z != right.z ||
        left.role != right.role || left.generic_id != right.generic_id ||
        left_state->horizontal_momentum[index] !=
            right_state->horizontal_momentum[index] ||
        left_state->falling[index] != right_state->falling[index] ||
        left_state->gravity_armed[index] !=
            right_state->gravity_armed[index]) {
      return false;
    }
  }
  return left_state->phase == right_state->phase &&
      left_state->direction == right_state->direction &&
      left_state->player_index == right_state->player_index &&
      left_state->player_gravity_armed == right_state->player_gravity_armed &&
      left_state->player_falling == right_state->player_falling &&
      left_state->reserved[0] == right_state->reserved[0] &&
      left_state->reserved[1] == right_state->reserved[1];
}

bool BaselineCycleStateMatches(
    const CommandCycleTracker& tracker,
    const Voxel* voxels,
    const MotionState* state) {
  if (state->direction != tracker.initial_direction ||
      (state->phase != kMotionPlayerIce &&
       state->phase != kMotionObjectIce) ||
      state->player_falling != 0) {
    return false;
  }
  for (int32_t index = 0; index < tracker.count; ++index) {
    const Voxel& baseline = tracker.baseline[index];
    const Voxel& current = voxels[index];
    if (baseline.x != current.x || baseline.y != current.y ||
        baseline.z != current.z || baseline.role != current.role ||
        baseline.generic_id != current.generic_id || state->falling[index] != 0) {
      return false;
    }
  }
  return true;
}

void BeginCommandCycleTracking(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  CommandCycleTracker& tracker = g_command_cycle_tracker;
  tracker.enabled = false;
  tracker.pending_rollback = false;
  tracker.wait_for_orange_transition = false;
  tracker.orange_transition_started = false;
  tracker.last_orange_depth_sum = OrangeDepthSum(voxels, count);
  tracker.source_voxels = voxels;
  tracker.source_state = state;
  tracker.count = count;
  tracker.width = width;
  tracker.height = height;
  tracker.initial_direction = direction;

  bool has_slope = false;
  bool has_orange_mechanism = false;
  const WorkspaceData* workspace_data = workspace == nullptr
      ? nullptr
      : WorkspaceStorage(workspace);
  if (workspace_data != nullptr && workspace_data->prepared_voxels == voxels &&
      workspace_data->prepared_count == count &&
      workspace_data->prepared_width == width &&
      workspace_data->prepared_height == height) {
    has_slope = workspace_data->prepared_has_ice_slopes;
    has_orange_mechanism =
        workspace_data->prepared_has_orange_mechanisms;
  } else {
    for (int32_t index = 0; index < count; ++index) {
      has_slope |= IsIceSlopeRole(voxels[index].role);
      has_orange_mechanism |=
          voxels[index].role == kOrangeButtonRole ||
          voxels[index].role == kOrangeWallRole;
    }
  }
  if (!has_slope && !has_orange_mechanism) return;
  tracker.wait_for_orange_transition = has_orange_mechanism && !has_slope;

  for (int32_t index = 0; index < count; ++index) {
    tracker.baseline[index] = voxels[index];
  }
  if (!tracker.replay_workspace_initialized) {
    reset_workspace(&tracker.replay_workspace);
    tracker.replay_workspace_initialized = true;
  }
  ++tracker.generation;
  if (tracker.generation == 0) {
    for (int32_t index = 0; index < kCycleHistoryCapacity; ++index) {
      tracker.history[index].generation = 0;
    }
    tracker.generation = 1;
  }
  tracker.enabled = true;
}

bool ReplayMatchesCycleTick(
    CommandCycleTracker& tracker,
    int32_t tick,
    const Voxel* current_voxels,
    const MotionState* current_state) {
  for (int32_t index = 0; index < tracker.count; ++index) {
    tracker.replay_voxels[index] = tracker.baseline[index];
  }
  reset_motion_state(&tracker.replay_state);
  int32_t iterations = 0;
  while (tracker.replay_state.tick < tick && iterations < 1000000) {
    const TickResult result = step_tick(
        &tracker.replay_workspace,
        &tracker.replay_state,
        tracker.replay_voxels,
        tracker.count,
        tracker.width,
        tracker.height,
        tracker.initial_direction);
    if (result == TickResult::kInvalid || result == TickResult::kNoPlayer ||
        result == TickResult::kComplete) {
      return false;
    }
    ++iterations;
  }
  return tracker.replay_state.tick == tick && SameCycleState(
      tracker.replay_voxels,
      &tracker.replay_state,
      current_voxels,
      current_state,
      tracker.count);
}

int32_t FindOrRecordCycleState(
    CommandCycleTracker& tracker,
    Voxel* voxels,
    MotionState* state) {
  if (BaselineCycleStateMatches(tracker, voxels, state)) return 0;
  if (state->tick == 1) {
    // Tick one contains the commanded actor transition. A level-wide
    // autonomous cycle begins only after that input has seeded the motion;
    // otherwise an actuator which revisits the post-input state reports a
    // cycle one tick earlier than the repeating autonomous interval.
    return -1;
  }
  const uint64_t hash = CycleStateHash(voxels, tracker.count, state);
  int32_t slot = static_cast<int32_t>(
      hash & static_cast<uint64_t>(kCycleHistoryMask));
  for (int32_t probe = 0; probe < kCycleHistoryCapacity; ++probe) {
    CycleHistoryEntry& entry = tracker.history[slot];
    if (entry.generation != tracker.generation) {
      entry = {hash, state->tick, tracker.generation};
      return -1;
    }
    if (entry.hash == hash && ReplayMatchesCycleTick(
            tracker, entry.tick, voxels, state)) {
      return entry.tick;
    }
    slot = (slot + 1) & kCycleHistoryMask;
  }
  tracker.enabled = false;
  return -1;
}

void RestoreCycleBaseline(
    PhysicsWorkspace* workspace,
    CommandCycleTracker& tracker,
    MotionState* state,
    Voxel* voxels) {
  for (int32_t index = 0; index < tracker.count; ++index) {
    voxels[index] = tracker.baseline[index];
    state->horizontal_momentum[index] = 0;
    state->falling[index] = 0;
    state->gravity_armed[index] = 0;
  }
  state->phase = kMotionComplete;
  state->direction = tracker.initial_direction;
  state->player_gravity_armed = 0;
  state->player_falling = 0;
  state->reserved[0] = 0;
  state->reserved[1] = 0;
  WorkspaceData* data = WorkspaceStorage(workspace);
  data->continuation_state = nullptr;
  data->continuation_voxels = nullptr;
  data->continuation_tick = -1;
  tracker.pending_rollback = false;
  tracker.enabled = false;
}
