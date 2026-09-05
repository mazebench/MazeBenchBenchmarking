constexpr int32_t kMotionReady = 0;
constexpr int32_t kMotionPlayerIce = 1;
constexpr int32_t kMotionObjectIce = 2;
constexpr int32_t kMotionGravity = 3;
constexpr int32_t kMotionComplete = 4;
constexpr int32_t kMotionPlayerLift = 5;
constexpr int32_t kMotionOrangeMechanisms = 6;
constexpr int32_t kMotionPlayerPunch = 7;
constexpr int32_t kMotionPlayerPunchUp = 8;
constexpr int32_t kMotionPlayerPunchDown = 9;
constexpr int32_t kMotionPlayerGates = 10;
constexpr uint8_t kResumeNothing = 0;
constexpr uint8_t kResumePlayerIce = 1;
constexpr uint8_t kResumeObjectIce = 2;
constexpr uint8_t kResumeCommand = 3;
constexpr uint8_t kResumeVacatedLift = 4;

constexpr uint8_t kPunchMomentumBase = 9;
constexpr uint8_t kLatentPunchMomentumBase = 13;

bool IsPunchMomentum(uint8_t momentum) {
  return momentum >= kPunchMomentumBase &&
      momentum < kLatentPunchMomentumBase + 4;
}

bool IsPlayerPunchPhase(int32_t phase) {
  return phase == kMotionPlayerPunch ||
      phase == kMotionPlayerPunchUp ||
      phase == kMotionPlayerPunchDown;
}

bool IsLatentMomentum(uint8_t momentum) {
  return (momentum >= 5 && momentum <= 8) ||
      momentum >= kLatentPunchMomentumBase;
}

uint8_t ReadObjectFlag(
    const uint8_t* flags,
    int32_t object) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (flags[member] != 0) return 1;
  }
  return 0;
}

uint8_t ReadObjectMomentum(
    const uint8_t* flags,
    int32_t object) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (flags[member] != 0) return flags[member];
  }
  return 0;
}

void LoadObjectMotion(const MotionState* state) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_falling[object] = ReadObjectFlag(state->falling, object);
    g_object_gravity_armed[object] =
        ReadObjectFlag(state->gravity_armed, object);
  }
}

void StoreObjectMotion(MotionState* state, int32_t count) {
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = 0; index < motion_count; ++index) {
    state->falling[index] = 0;
    state->gravity_armed[index] = 0;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->falling[member] = g_object_falling[object];
      state->gravity_armed[member] = g_object_gravity_armed[object];
    }
  }
}

void ClearHorizontalMomentum(MotionState* state, int32_t count) {
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = 0; index < motion_count; ++index) {
    state->horizontal_momentum[index] = 0;
  }
}

void ClearImmutableMotionSuffix(MotionState* state, int32_t count) {
  // Prepared scenes keep immutable terrain after the dynamic prefix. Physics
  // never reads motion for that suffix, but MotionState is public and
  // serializable, so initialize the exposed bytes once per command.
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = motion_count; index < count; ++index) {
    state->horizontal_momentum[index] = 0;
    state->falling[index] = 0;
    state->gravity_armed[index] = 0;
  }
}

void StoreMandatoryMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t fallback_direction) {
  ClearHorizontalMomentum(state, count);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t direction = g_object_direction[object] <= 3
          ? g_object_direction[object]
          : fallback_direction;
      state->horizontal_momentum[member] =
          static_cast<uint8_t>(direction + 1);
    }
  }
}

bool FloatingFloorHasIceDrivenActorBehind(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (!ObjectIsFloatingFloor(voxels, object) ||
      g_object_direction[object] > 3) {
    return false;
  }
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t direction = g_object_direction[object];
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t behind = FindVoxelAt(
        voxels,
        voxels[member].x - kDx[direction],
        voxels[member].y - kDy[direction],
        voxels[member].z,
        width,
        height);
    if (behind < 0 ||
        (voxels[behind].role != kPlayerRole &&
         !IsCloneObjectRole(voxels[behind].role))) {
      continue;
    }
    if (IsSupportedByIce(voxels, voxels[behind], width, height)) {
      return true;
    }
  }
  return false;
}

bool StoreSupportedMandatoryMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t fallback_direction) {
  // Snapshot the incoming serialized momentum before replacing it. A body
  // can land on a lower slope during the gravity half of this very tick; it
  // is no longer marked falling or mandatory by then, but its saved direction
  // must resume on the newly reached ramp.
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_redirected[object] = ReadObjectMomentum(
        state->horizontal_momentum, object);
  }
  ClearHorizontalMomentum(state, count);
  bool stored = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    const bool punch_momentum = IsPunchMomentum(g_object_redirected[object]);
    const bool ice_driven_floating_floor =
        FloatingFloorHasIceDrivenActorBehind(
            voxels, object, width, height);
    const bool supported_momentum =
        (g_inherited_support_motion[object] != 0 ||
         g_mandatory_objects[object] != 0 ||
         g_object_redirected[object] != 0) &&
        (punch_momentum || g_inherited_support_motion[object] != 0 ||
         ObjectIsFullyOnIce(voxels, object, width, height) ||
         ice_driven_floating_floor);
    bool supported_by_momentum_body = false;
    bool supported_by_nonfalling_momentum_body = false;
    uint8_t supporting_momentum_direction = UINT8_MAX;
    if (!supported_momentum && g_object_redirected[object] != 0) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 && support_object != object &&
            g_object_redirected[support_object] != 0) {
          supported_by_momentum_body = true;
          supported_by_nonfalling_momentum_body |=
              g_object_falling[support_object] == 0;
          if (g_object_falling[support_object] == 0 &&
              g_object_direction[support_object] <= 3) {
            supporting_momentum_direction =
                g_object_direction[support_object];
          }
        }
      }
    }
    const bool moved_with_momentum_body =
        supported_by_nonfalling_momentum_body &&
        g_mandatory_objects[object] != 0;
    bool falling_toward_slope = false;
    if (!supported_momentum && g_object_falling[object] != 0) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (VoxelWillLandOnSlope(
                voxels, count, voxels[member], object, width)) {
          falling_toward_slope = true;
          break;
        }
      }
    }
    if (!supported_momentum && !falling_toward_slope &&
        !supported_by_momentum_body) {
      continue;
    }
    stored |= supported_momentum || moved_with_momentum_body;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t direction =
          moved_with_momentum_body && supporting_momentum_direction <= 3
          ? supporting_momentum_direction
          : g_object_direction[object] <= 3
              ? g_object_direction[object]
              : fallback_direction;
      const bool moving = supported_momentum || moved_with_momentum_body;
      state->horizontal_momentum[member] = static_cast<uint8_t>(direction +
          (punch_momentum
              ? moving ? kPunchMomentumBase : kLatentPunchMomentumBase
              : moving ? 1 : 5));
    }
  }
  return stored;
}

void RestoreMandatoryMomentum(
    const MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (int32_t object = 0; object < g_object_count; ++object) {
    const uint8_t momentum = ReadObjectMomentum(
        state->horizontal_momentum, object);
    if (momentum == 0) {
      g_object_direction[object] = UINT8_MAX;
      continue;
    }
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>((momentum - 1) & 3);
    if ((IsLatentMomentum(momentum) && !IsPunchMomentum(momentum) &&
         !ObjectIsFullyOnIce(voxels, object, width, height)) ||
        g_object_falling[object] != 0) {
      // Momentum remains serialized while a body falls toward a lower slope,
      // but it is not a horizontal proposal until the body lands.
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
    }
  }
}

void CancelConflictingLandedSlopeMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  // A rigid body landing across slopes with different downhill directions is
  // stable. Its pre-fall direction cannot choose one supporting wedge over
  // another. A later deliberate push may still move the body transactionally.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectHasConflictingSlopeSupports(
            voxels, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->horizontal_momentum[member] = 0;
    }
    g_mandatory_objects[object] = 0;
    g_moving_objects[object] = 0;
  }
}

bool StoredMomentumWillLandOnSlope(
    const MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (ReadObjectMomentum(state->horizontal_momentum, object) == 0 ||
        g_object_falling[object] == 0) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (VoxelWillLandOnSlope(
              voxels, count, voxels[member], object, width)) {
        return true;
      }
    }
  }
  return false;
}

struct RiderSnapshot {
  int32_t object = -1;
  int32_t member = -1;
  int32_t x = 0;
  int32_t y = 0;
  int32_t z = 0;
};

RiderSnapshot CapturePlayerRider(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  RiderSnapshot rider;
  const Voxel& player = voxels[player_index];
  if (player.z == INT32_MIN) return rider;
  const int32_t support = FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height);
  if (support < 0 || g_voxel_object[support] < 0) return rider;
  rider.object = g_voxel_object[support];
  rider.member = g_object_head[rider.object];
  rider.x = voxels[rider.member].x;
  rider.y = voxels[rider.member].y;
  rider.z = voxels[rider.member].z;
  return rider;
}

bool MovePlayerWithRider(
    Voxel* voxels,
    int32_t player_index,
    const RiderSnapshot& rider,
    int32_t width,
    int32_t height) {
  if (rider.object < 0 || g_moving_objects[rider.object] == 0 ||
      !ObjectIsActive(voxels, rider.object, width, height)) {
    return false;
  }
  voxels[player_index].x += voxels[rider.member].x - rider.x;
  voxels[player_index].y += voxels[rider.member].y - rider.y;
  voxels[player_index].z += voxels[rider.member].z - rider.z;
  return true;
}

void InitializeMotion(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t player_index,
    int32_t direction) {
  state->version = kMotionStateVersion;
  state->phase = kMotionReady;
  state->direction = direction;
  state->tick = 0;
  state->voxel_count = count;
  state->player_index = player_index;
  state->player_gravity_armed = 0;
  state->player_falling = 0;
  state->reserved[0] = kResumeNothing;
  state->reserved[1] = 0;
  // reserved[1] stores the phase resumed after an orange mechanism tick.
  state->reserved[1] = static_cast<uint8_t>(kMotionReady);
  for (int32_t index = 0; index < count; ++index) {
    g_blocked_orange_walls[index] = 0;
  }
  // StoreObjectMotion below replaces the falling/gravity arrays completely;
  // only horizontal momentum needs an independent reset here.
  ClearHorizontalMomentum(state, count);
  bool needs_initial_gravity = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (ObjectHasDirectSupport(voxels, object, width, height)) {
      g_object_gravity_armed[object] = 1;
      continue;
    }
    if (ObjectIsActive(voxels, object, width, height)) {
      if (ObjectIsFloatingFloor(voxels, object)) {
        // A Floating Floor authored in mid-air remains at that elevation.
        // Once translated, the movement kernels arm it so subsequent support
        // loss is animated normally. This is what distinguishes an authored
        // hovering platform from an accidentally airborne ordinary body.
        continue;
      }
      // Dynamic bodies are never allowed to begin a command suspended in the
      // editor volume. Arm them even over the abyss so they settle or leave
      // the world before the requested horizontal input is evaluated.
      g_object_gravity_armed[object] = 1;
      g_object_falling[object] = 1;
      needs_initial_gravity = true;
    }
  }
  const Voxel& player = voxels[player_index];
  const bool player_active =
      IsInsideRoom(player.x, player.y, width, height) &&
      player.z != INT32_MIN;
  const bool player_supported = player_active && FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height) >= 0;
  state->player_gravity_armed = player_active ? 1 : 0;
  if (player_active && !player_supported) {
    state->player_falling = 1;
    needs_initial_gravity = true;
  }
  if (needs_initial_gravity) {
    state->phase = kMotionGravity;
    state->reserved[0] = kResumeCommand;
  }
  StoreObjectMotion(state, count);
  ClearImmutableMotionSuffix(state, count);
}

void InitializeQuiescentMotion(
    MotionState* state,
    int32_t count,
    int32_t player_index,
    int32_t direction) {
  state->version = kMotionStateVersion;
  state->phase = kMotionReady;
  state->direction = direction;
  state->tick = 0;
  state->voxel_count = count;
  state->player_index = player_index;
  state->player_gravity_armed = 1;
  state->player_falling = 0;
  state->reserved[0] = kResumeNothing;
  state->reserved[1] = 0;
  state->reserved[1] = static_cast<uint8_t>(kMotionReady);
  for (int32_t index = 0; index < count; ++index) {
    g_blocked_orange_walls[index] = 0;
  }
  // StoreObjectMotion below replaces the falling/gravity arrays completely.
  ClearHorizontalMomentum(state, count);
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_gravity_armed[object] = 1;
    g_object_falling[object] = 0;
  }
  StoreObjectMotion(state, count);
  // This state is private to simulate_quiescent_turn and is never serialized;
  // unlike the public step_tick path, its immutable suffix need not be stored.
}

void CollectGoalsAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  if (player_index < 0 || player_index >= count) return;
  const Voxel& player = voxels[player_index];
  if (IsPreparedScene(voxels, count, width, height)) {
    const WorkspaceData& workspace = ActiveWorkspace();
    for (int32_t goal = 0; goal < workspace.prepared_goal_count; ++goal) {
      Voxel& voxel = voxels[workspace.prepared_goal_indices[goal]];
      if (voxel.x == player.x && voxel.y == player.y && voxel.z == player.z) {
        voxel.x = -1;
      }
    }
    return;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kGoalRole && voxels[index].x == player.x &&
        voxels[index].y == player.y && voxels[index].z == player.z) {
      voxels[index].x = -1;
    }
  }
}

void CollectGoalsAtActors(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  CollectGoalsAtPlayer(voxels, count, player_index, width, height);
  auto collect_if_overlapped = [&](int32_t goal_index) {
    Voxel& goal = voxels[goal_index];
    if (goal.role != kGoalRole ||
        !IsInsideRoom(goal.x, goal.y, width, height)) {
      return;
    }
    for (int32_t index = 0; index < count; ++index) {
      if ((IsCloneObjectRole(voxels[index].role) ||
           voxels[index].role == kPlayerRole) &&
          voxels[index].x == goal.x && voxels[index].y == goal.y &&
          voxels[index].z == goal.z) {
        goal.x = -1;
        return;
      }
    }
  };
  if (IsPreparedScene(voxels, count, width, height)) {
    const WorkspaceData& workspace = ActiveWorkspace();
    for (int32_t goal = 0; goal < workspace.prepared_goal_count; ++goal) {
      collect_if_overlapped(workspace.prepared_goal_indices[goal]);
    }
    return;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kGoalRole) collect_if_overlapped(index);
  }
}

bool OrangeFixtureRidesWallSurface(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z);

bool OrangeFixtureTracksWall(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z);

bool OrangeButtonIsHidden(const Voxel& button) {
  return button.role == kOrangeButtonRole &&
      button.generic_id >= 0 && (button.generic_id & 1) != 0;
}

bool RefreshOrangeButtonVisibility(
    Voxel* voxels,
    int32_t count) {
  bool changed = false;
  for (int32_t button_index = 0; button_index < count; ++button_index) {
    Voxel& button = voxels[button_index];
    if (button.role != kOrangeButtonRole || button.generic_id < 0) continue;
    bool rides_wall = false;
    bool folded_into_support = false;
    for (int32_t wall_index = 0; wall_index < count; ++wall_index) {
      if (voxels[wall_index].role != kOrangeWallRole) continue;
      const int32_t surface = OrangeWallSurfaceZForDepth(
          voxels, count, wall_index, OrangeWallDepth(voxels[wall_index]));
      if (!OrangeFixtureTracksWall(
              button, voxels[wall_index], surface)) {
        continue;
      }
      rides_wall = true;
      const int32_t support = OrangeWallSupportZ(voxels, count, wall_index);
      folded_into_support |= support != INT32_MIN && button.z <= support;
    }
    bool rides_lift = false;
    for (int32_t lift_index = 0; lift_index < count; ++lift_index) {
      if (!OrangeButtonTracksPlayerLift(button, voxels[lift_index])) continue;
      rides_lift = true;
      folded_into_support |= !PlayerLiftIsRaised(voxels[lift_index]);
    }
    if (!rides_wall && !rides_lift) continue;
    const int32_t next_id = (button.generic_id & ~1) |
        (folded_into_support ? 1 : 0);
    if (button.generic_id != next_id) {
      button.generic_id = next_id;
      changed = true;
    }
  }
  return changed;
}

bool OrangeButtonShouldBePressed(
    Voxel* voxels,
    int32_t button_index,
    int32_t width,
    int32_t height) {
  const Voxel& button = voxels[button_index];
  if (button.role != kOrangeButtonRole ||
      OrangeButtonIsHidden(button) ||
      !IsInsideRoom(button.x, button.y, width, height) ||
      button.z == INT32_MIN) {
    return false;
  }
  const int32_t occupant = FindVoxelAt(
      voxels, button.x, button.y, button.z, width, height);
  if (occupant < 0) return false;
  if (voxels[occupant].role == kPlayerRole) return true;
  const int32_t object = g_voxel_object[occupant];
  if (object < 0) {
    // Static geometry can press a button which its movable carrier drives
    // into that geometry. The exception is a wall-mounted sensor currently
    // folded into terrain by the Orange Wall itself; that face is invisible,
    // and therefore contributes no pressure.
    for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
      if (voxels[index].role != kOrangeWallRole) continue;
      const int32_t surface = OrangeWallSurfaceZForDepth(
          voxels, g_spatial_voxel_count, index,
          OrangeWallDepth(voxels[index]));
      const int32_t support = OrangeWallSupportZ(
          voxels, g_spatial_voxel_count, index);
      if (OrangeFixtureTracksWall(button, voxels[index], surface) &&
          support != INT32_MIN && button.z <= support) {
        return false;
      }
    }
    return true;
  }
  // Static terrain and the mechanism's own mount do not press a sensor when
  // the face is folded into them. Only an actor or movable rigid body applies
  // pressure; other mechanism fixtures remain freely overlappable.
  if (g_object_kind[object] == kMechanismObject) {
    const int32_t fixture = g_object_head[object];
    return fixture >= 0 && voxels[fixture].role == kPlayerLiftRole &&
        PlayerLiftIsRaised(voxels[fixture]);
  }
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

void CountPressedOrangeButtons(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t* pressed) {
  for (int32_t scope = 0; scope < kOrangeScopeCount; ++scope) pressed[scope] = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kOrangeButtonRole &&
        OrangeButtonShouldBePressed(
            voxels, index, width, height)) {
      ++pressed[OrangeScope(voxels[index])];
    }
  }
}

bool NormalizeInitialOrangeWallAnchors(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  bool changed = RefreshOrangeButtonVisibility(voxels, count);
  int32_t pressed_by_scope[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, pressed_by_scope);
  for (int32_t index = 0; index < count; ++index) {
    Voxel& wall = voxels[index];
    if (wall.role != kOrangeWallRole) continue;
    const int32_t pressed = pressed_by_scope[OrangeScope(wall)];
    const int32_t depth = OrangeWallDepth(wall);
    if (depth >= pressed) continue;
    // A frame imported while its buttons are already held may still carry the
    // old zero-depth cube value. Canonicalize only states whose pressed
    // projection is non-solid, so input collision agrees with the visible
    // face/hidden starting frame. Ordinary cubes still animate normally.
    if (OrangeWallIsFlatForDepth(voxels, count, index, pressed) ||
        OrangeWallIsHiddenForDepth(voxels, count, index, pressed)) {
      SetOrangeWallDepth(&wall, pressed);
      changed = true;
    }
  }
  return changed;
}

bool OrangeMechanismsNeedTick(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  int32_t pressed_by_scope[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, pressed_by_scope);
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kOrangeWallRole &&
        g_blocked_orange_walls[index] == 0 &&
        OrangeWallDepth(voxels[index]) != pressed_by_scope[OrangeScope(voxels[index])]) {
      return true;
    }
  }
  return false;
}

bool OrangeFixtureRidesWallSurface(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z) {
  if ((fixture.role != kOrangeButtonRole &&
       fixture.role != kPlayerLiftRole) ||
      fixture.generic_id < 0) {
    return false;
  }
  const int32_t orientation = OrangeLocalId(fixture) / 2;
  if (orientation == 0) {
    return fixture.x == wall.x && fixture.y == wall.y &&
        fixture.z == wall_surface_z;
  }
  if (orientation == 1) {
    return fixture.x == wall.x && fixture.y + 1 == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 2) {
    return fixture.x - 1 == wall.x && fixture.y == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 3) {
    return fixture.x == wall.x && fixture.y - 1 == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 4) {
    return fixture.x + 1 == wall.x && fixture.y == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  return fixture.role == kOrangeButtonRole && orientation == 5 &&
      fixture.x == wall.x && fixture.y == wall.y &&
      fixture.z + 2 == wall_surface_z;
}

// Once an Orange Wall is below its support plane it deliberately has no
// physical surface. A mounted fixture nevertheless remains attached to the
// same authored raised-anchor face and must continue travelling with it.
// Reconstructing the fixture's raised coordinate from the wall depth preserves
// that relationship without an attachment identifier or per-fixture hidden
// block type. Rendering may occlude the unchanged fixture when it is buried.
bool OrangeFixtureTracksWall(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z) {
  if (OrangeFixtureRidesWallSurface(fixture, wall, wall_surface_z)) return true;
  if ((fixture.role != kOrangeButtonRole &&
       fixture.role != kPlayerLiftRole) ||
      wall.role != kOrangeWallRole || fixture.generic_id < 0) {
    return false;
  }
  const int32_t orientation = OrangeLocalId(fixture) / 2;
  const int64_t raised_fixture_z = static_cast<int64_t>(fixture.z) +
      OrangeWallDepth(wall);
  if (orientation == 0) {
    return fixture.x == wall.x && fixture.y == wall.y &&
        raised_fixture_z == static_cast<int64_t>(wall.z) + 1;
  }
  const bool matching_side =
      (orientation == 1 && fixture.x == wall.x && fixture.y + 1 == wall.y) ||
      (orientation == 2 && fixture.x - 1 == wall.x && fixture.y == wall.y) ||
      (orientation == 3 && fixture.x == wall.x && fixture.y - 1 == wall.y) ||
      (orientation == 4 && fixture.x + 1 == wall.x && fixture.y == wall.y);
  if (matching_side) return raised_fixture_z == wall.z;
  return fixture.role == kOrangeButtonRole && orientation == 5 &&
      fixture.x == wall.x && fixture.y == wall.y &&
      raised_fixture_z == static_cast<int64_t>(wall.z) - 1;
}

bool OrangeWallsShareFace(const Voxel& left, const Voxel& right) {
  if (left.role != kOrangeWallRole || right.role != kOrangeWallRole) {
    return false;
  }
  if (OrangeScope(left) != OrangeScope(right)) return false;
  const int64_t dx = static_cast<int64_t>(left.x) - right.x;
  const int64_t dy = static_cast<int64_t>(left.y) - right.y;
  const int64_t dz = static_cast<int64_t>(left.z) - right.z;
  const int64_t distance = (dx < 0 ? -dx : dx) +
      (dy < 0 ? -dy : dy) + (dz < 0 ? -dz : dz);
  return distance == 1;
}

// A face-connected orange-wall polycube changes state as one mechanism. This
// preflight applies the component's destination geometry temporarily, runs
// the ordinary carried-body collision closure without committing movement,
// then restores the authored wall state. One blocked member therefore holds
// its connected wall component while disconnected walls remain independent.
void PreflightOrangeWallComponents(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    const int32_t* target_depths) {
  for (int32_t index = 0; index < count; ++index) {
    g_orange_component_walls[index] = 0;
    g_orange_component_shifts[index] = 0;
  }

  for (int32_t seed = 0; seed < count; ++seed) {
    if (voxels[seed].role != kOrangeWallRole ||
        g_orange_component_walls[seed] != 0) {
      continue;
    }

    int32_t queue_begin = 0;
    const int32_t target_depth = target_depths[OrangeScope(voxels[seed])];
    int32_t queue_end = 0;
    g_object_queue[queue_end++] = seed;
    g_orange_component_walls[seed] = 2;
    while (queue_begin < queue_end) {
      const int32_t member = g_object_queue[queue_begin++];
      for (int32_t candidate = 0; candidate < count; ++candidate) {
        if (g_orange_component_walls[candidate] != 0 ||
            !OrangeWallsShareFace(voxels[member], voxels[candidate])) {
          continue;
        }
        g_orange_component_walls[candidate] = 2;
        g_object_queue[queue_end++] = candidate;
      }
    }

    bool needs_transition = false;
    bool conflicting_deltas = false;
    int32_t component_delta = 0;
    bool player_rides_component = false;
    ClearMovingObjects();

    for (int32_t index = 0; index < count; ++index) {
      if (g_orange_component_walls[index] != 2) continue;
      Voxel& wall = voxels[index];
      const int32_t old_depth = OrangeWallDepth(wall);
      g_component_indegree[index] = old_depth;
      if (old_depth == target_depth) continue;
      needs_transition = true;
      const int32_t new_depth = old_depth +
          (old_depth < target_depth ? 1 : -1);
      const int32_t old_surface = OrangeWallSurfaceZForDepth(
          voxels, count, index, old_depth);
      const int32_t new_surface = OrangeWallSurfaceZForDepth(
          voxels, count, index, new_depth);
      const int32_t wall_delta = old_surface == INT32_MIN ||
              new_surface == INT32_MIN
          ? 0
          : new_surface - old_surface;
      if (wall_delta != 0) {
        if (component_delta != 0 && component_delta != wall_delta) {
          conflicting_deltas = true;
        } else {
          component_delta = wall_delta;
        }
        const Voxel& player = voxels[player_index];
        player_rides_component |= player.x == wall.x &&
            player.y == wall.y && player.z == old_surface;
        for (int32_t object = 0; object < g_object_count; ++object) {
          if (g_object_kind[object] == kMechanismObject) {
            const int32_t fixture = g_object_head[object];
            if (fixture >= 0 && OrangeFixtureTracksWall(
                    voxels[fixture], wall, old_surface)) {
              g_mandatory_objects[object] = 1;
              g_moving_objects[object] = 1;
            }
            continue;
          }
          for (int32_t object_member = g_object_head[object];
               object_member >= 0;
               object_member = g_next_object_voxel[object_member]) {
            if (voxels[object_member].x == wall.x &&
                voxels[object_member].y == wall.y &&
                voxels[object_member].z == old_surface) {
              g_mandatory_objects[object] = 1;
              g_moving_objects[object] = 1;
              break;
            }
          }
        }
      }
    }

    bool blocked = conflicting_deltas;
    if (needs_transition && !blocked) {
      for (int32_t index = 0; index < count; ++index) {
        if (g_orange_component_walls[index] != 2) continue;
        const int32_t old_depth = g_component_indegree[index];
        if (old_depth != target_depth) {
          SetOrangeWallDepth(
              &voxels[index],
              old_depth + (old_depth < target_depth ? 1 : -1));
        } else if (target_depth == 0 && component_delta > 0 &&
                   component_delta <= INT8_MAX) {
          // A wall cube that has no rise debt of its own is still part of the
          // same face-connected polycube. It rides the component motion while
          // retaining depth zero; disconnected zero-depth walls do not move.
          // A member already normalized to a nonzero target depth must stay
          // at its raised anchor while the remaining members catch up.
          g_orange_component_shifts[index] =
              static_cast<int8_t>(component_delta);
          voxels[index].z += component_delta;
        }
      }
      BuildSpatialIndex(voxels, count, width, height);

      for (int32_t index = 0; index < count && !blocked; ++index) {
        if (g_orange_component_walls[index] != 2 ||
            g_component_indegree[index] == target_depth) {
          continue;
        }
        const Voxel& wall = voxels[index];
        if (OrangeWallIsHiddenForDepth(
                voxels,
                count,
                index,
                OrangeWallDepth(wall))) {
          continue;
        }
        const int32_t new_top = OrangeWallPhysicalZ(voxels, count, index);
        const int32_t occupant = FindVoxelAt(
            voxels, wall.x, wall.y, new_top, width, height);
        if (occupant < 0 || occupant == index || occupant == player_index ||
            (voxels[occupant].role == kOrangeWallRole &&
             g_orange_component_walls[occupant] == 2)) {
          continue;
        }
        const int32_t occupant_object = g_voxel_object[occupant];
        blocked = occupant_object < 0 ||
            g_mandatory_objects[occupant_object] == 0;
      }

      if (!blocked && player_rides_component && component_delta != 0) {
        const Voxel& player = voxels[player_index];
        const int32_t player_target = FindVoxelAt(
            voxels,
            player.x,
            player.y,
            player.z + component_delta,
            width,
            height);
        if (player_target >= 0 && player_target != player_index &&
            !(voxels[player_target].role == kOrangeWallRole &&
              g_orange_component_walls[player_target] == 2)) {
          const int32_t target_object = g_voxel_object[player_target];
          if (target_object < 0) {
            blocked = true;
          } else {
            g_mandatory_objects[target_object] = 1;
            g_moving_objects[target_object] = 1;
          }
        }
      }

      if (!blocked && component_delta != 0) {
        blocked = !TranslateMovingObjects(
            voxels,
            count,
            player_index,
            0,
            0,
            component_delta,
            width,
            height,
            player_rides_component,
            true,
            true,
            false,
            false);
      }

      for (int32_t index = 0; index < count; ++index) {
        if (g_orange_component_walls[index] == 2) {
          voxels[index].z -= g_orange_component_shifts[index];
          SetOrangeWallDepth(&voxels[index], g_component_indegree[index]);
        }
      }
      BuildSpatialIndex(voxels, count, width, height);
    }

    for (int32_t index = 0; index < count; ++index) {
      if (g_orange_component_walls[index] != 2) continue;
      if (blocked) g_blocked_orange_walls[index] = 1;
      g_orange_component_walls[index] = 1;
    }
  }
}

bool AdvanceOrangeMechanismsOneTick(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  int32_t target_depths[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, target_depths);
  PreflightOrangeWallComponents(
      voxels, count, player_index, width, height, target_depths);
  bool changed = false;
  bool player_moved_with_wall_component = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    // Scratch ownership for this actuator pass. A rigid rider may touch more
    // than one face of the same connected Orange Wall component, but the
    // component changes height only once per tick.
    g_clone_command_processed[object] = 0;
  }

  for (int32_t index = 0; index < count; ++index) {
    Voxel& wall = voxels[index];
    if (wall.role != kOrangeWallRole || g_blocked_orange_walls[index] != 0) {
      continue;
    }
    const int32_t old_depth = OrangeWallDepth(wall);
    const int32_t component_shift = g_orange_component_shifts[index];
    const int32_t target_depth = target_depths[OrangeScope(wall)];
    if (old_depth == target_depth && component_shift == 0) continue;
    const int32_t new_depth = old_depth == target_depth
        ? old_depth
        : old_depth + (old_depth < target_depth ? 1 : -1);
    const int32_t old_surface = OrangeWallSurfaceZForDepth(
        voxels, count, index, old_depth);
    int32_t new_surface = OrangeWallSurfaceZForDepth(
        voxels, count, index, new_depth);
    if (component_shift != 0 && new_surface != INT32_MIN) {
      new_surface += component_shift;
    }
    const int32_t wall_delta = old_surface == INT32_MIN ||
            new_surface == INT32_MIN
        ? 0
        : new_surface - old_surface;
    if (wall_delta == 0) {
      // A flat-to-hidden (or hidden-to-flat) transition has no rigid surface
      // to carry an ordinary body, but a face-mounted button remains attached
      // to the authored Orange Wall and advances one depth unit with it.
      const int32_t fixture_delta = component_shift != 0
          ? component_shift
          : old_depth == new_depth ? 0 : old_depth < new_depth ? -1 : 1;
      if (fixture_delta != 0) {
        for (int32_t object = 0; object < g_object_count; ++object) {
          if (g_clone_command_processed[object] != 0 ||
              g_object_kind[object] != kMechanismObject) {
            continue;
          }
          const int32_t member = g_object_head[object];
          if (member < 0 || !OrangeFixtureTracksWall(
                  voxels[member], wall, old_surface)) {
            continue;
          }
          voxels[member].z += fixture_delta;
          g_clone_command_processed[object] = 1;
        }
      }
      SetOrangeWallDepth(&wall, new_depth);
      changed = true;
      BuildSpatialIndex(voxels, count, width, height);
      continue;
    }

    ClearMovingObjects();
    const RiderSnapshot player_rider = CapturePlayerRider(
        voxels, player_index, width, height);
    const Voxel& player = voxels[player_index];
    const bool player_rides_wall = !player_moved_with_wall_component &&
        player.x == wall.x && player.y == wall.y && player.z == old_surface;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_clone_command_processed[object] != 0) continue;
      if (g_object_kind[object] == kMechanismObject) {
        const int32_t member = g_object_head[object];
        if (member >= 0 && OrangeFixtureTracksWall(
                voxels[member], wall, old_surface)) {
          g_mandatory_objects[object] = 1;
          g_moving_objects[object] = 1;
        }
        continue;
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].x == wall.x && voxels[member].y == wall.y &&
            voxels[member].z == old_surface) {
          g_mandatory_objects[object] = 1;
          g_moving_objects[object] = 1;
          break;
        }
      }
    }

    bool blocked = false;
    if (!OrangeWallIsHiddenForDepth(voxels, count, index, new_depth) &&
        !OrangeWallIsFlatForDepth(voxels, count, index, new_depth)) {
      int32_t new_top = OrangeWallPhysicalZForDepth(
          voxels, count, index, new_depth);
      if (component_shift != 0) new_top += component_shift;
      const int32_t wall_occupant = FindVoxelAt(
          voxels, wall.x, wall.y, new_top, width, height);
      if (wall_occupant >= 0 && wall_occupant != index) {
        bool occupant_vacates = false;
        if (voxels[wall_occupant].role == kOrangeWallRole) {
          const int32_t occupant_depth = OrangeWallDepth(
              voxels[wall_occupant]);
          const int32_t occupant_target = target_depths[OrangeScope(voxels[wall_occupant])];
          if (occupant_depth != occupant_target) {
            const int32_t occupant_new_depth = occupant_depth +
                (occupant_depth < occupant_target ? 1 : -1);
            occupant_vacates =
                OrangeWallIsFlatForDepth(
                    voxels, count, wall_occupant, occupant_new_depth) ||
                OrangeWallIsHiddenForDepth(
                    voxels, count, wall_occupant, occupant_new_depth) ||
                OrangeWallPhysicalZForDepth(
                    voxels, count, wall_occupant, occupant_new_depth) !=
                    new_top;
          }
        }
        if (!occupant_vacates) {
          const int32_t occupant_object = g_voxel_object[wall_occupant];
          blocked = wall_occupant != player_index &&
              (occupant_object < 0 ||
               g_mandatory_objects[occupant_object] == 0);
        }
      }
    }
    if (!blocked && player_rides_wall) {
      const int32_t player_target = FindVoxelAt(
          voxels,
          player.x,
          player.y,
          player.z + wall_delta,
          width,
          height);
      if (player_target >= 0 && player_target != index) {
        const int32_t target_object = g_voxel_object[player_target];
        if (target_object < 0) {
          blocked = true;
        } else {
          // A body directly above the player is part of the same lift
          // proposal. Seed it before collision validation so the ordinary
          // carrier closure can bring its complete rigid group along. Static
          // terrain in this destination still blocks the wall transaction.
          g_mandatory_objects[target_object] = 1;
          g_moving_objects[target_object] = 1;
        }
      }
    }
    if (!blocked) {
      // Validate riders against the wall's destination geometry. In
      // particular, a lowering rider moves into the wall's old top cell,
      // which is vacated by this same mechanism tick.
      SetOrangeWallDepth(&wall, new_depth);
      wall.z += component_shift;
      BuildSpatialIndex(voxels, count, width, height);
    }
    if (!blocked) {
      blocked = !TranslateMovingObjects(
          voxels,
          count,
          player_index,
          0,
          0,
          wall_delta,
          width,
          height,
          player_rides_wall,
          true,
          true,
          false);
    }
    if (blocked) {
      SetOrangeWallDepth(&wall, old_depth);
      wall.z -= component_shift;
      g_blocked_orange_walls[index] = 1;
      BuildSpatialIndex(voxels, count, width, height);
      continue;
    }

    const bool player_rode_object = MovePlayerWithRider(
        voxels, player_index, player_rider, width, height);
    if (player_rides_wall && !player_rode_object) {
      voxels[player_index].z += wall_delta;
    }
    player_moved_with_wall_component |=
        player_rides_wall || player_rode_object;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] != 0) {
        g_clone_command_processed[object] = 1;
      }
    }
    changed = true;
    BuildSpatialIndex(voxels, count, width, height);
  }

  changed |= RefreshOrangeButtonVisibility(voxels, count);
  if (!changed) return false;
  BuildSpatialIndex(voxels, count, width, height);
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  state->player_gravity_armed = 1;
  return true;
}

// Exact accelerator for a quiescent command whose only possible moving body is
// the player. It deliberately declines pushes and carried-body interactions;
// those continue through the same full command kernel. Keeping this decision
// in physics (rather than in search) gives every caller identical semantics for
// walking, elevated supports, Ice, gravity, abyss removal, and collectibles.
// Returns 1 when handled, 0 when the full kernel is required, and a negative
// public simulation error for invalid input/no player.
int32_t TrySimulatePassiveQuiescentTurn(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    bool rebuild_spatial_index) {
  if (!IsPreparedScene(voxels, count, width, height)) return 0;
  // Directional slopes can change both the motion vector and elevation. They
  // stay on the generalized command kernel, including exact cycle handling.
  if (ActiveWorkspace().prepared_has_ice_slopes ||
      ActiveWorkspace().prepared_has_player_lifts ||
      ActiveWorkspace().prepared_has_orange_mechanisms ||
      ActiveWorkspace().prepared_has_punchers ||
      ActiveWorkspace().prepared_has_floating_floors ||
      ActiveWorkspace().prepared_has_clones ||
      ActiveWorkspace().prepared_has_player_polycube ||
      ActiveWorkspace().scene_has_player_gates) return 0;
  const int32_t player_index = ActiveWorkspace().prepared_player_index;
  if (player_index < 0 || player_index >= count ||
      voxels[player_index].role != kPlayerRole) {
    return -2;
  }
  Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height) ||
      player.z == INT32_MIN) {
    return -2;
  }

  if (rebuild_spatial_index) {
    ResetObjectMotion();
    BuildSpatialIndex(voxels, count, width, height);
  } else if (!ActiveWorkspace().prepared_index_active) {
    return 0;
  }
  g_ignored_support_voxel = player_index;
  constexpr int32_t kDx[4] = {0, 1, 0, -1};
  constexpr int32_t kDy[4] = {-1, 0, 1, 0};
  const int32_t dx = kDx[direction];
  const int32_t dy = kDy[direction];
  int32_t x = player.x;
  int32_t y = player.y;
  int32_t z = player.z;
  bool automatic_ice_motion = false;

  auto support_at = [&](int32_t support_x, int32_t support_y, int32_t support_z) {
    const int32_t support = FindVoxelAt(
        voxels, support_x, support_y, support_z, width, height);
    return support == player_index ? -1 : support;
  };
  auto has_carried_body = [&]() {
    if (z == INT32_MAX) return false;
    const int32_t above = FindVoxelAt(voxels, x, y, z + 1, width, height);
    return above >= 0 && g_voxel_object[above] >= 0;
  };
  auto fall_until_settled = [&]() {
    for (;;) {
      if (z == INT32_MIN) {
        x = -1;
        return;
      }
      if (support_at(x, y, z - 1) >= 0) return;
      const int32_t lower_support = FindNearestVoxelBelow(
          voxels, count, x, y, z, -1, width);
      const int32_t previous_z = z;
      --z;
      if (lower_support < 0 && previous_z < LowestOtherActiveZ(
              voxels, count, width, height, -1, player_index, false, true)) {
        x = -1;
        return;
      }
    }
  };

  for (;;) {
    if (has_carried_body()) {
      g_ignored_support_voxel = -1;
      return 0;
    }
    const bool started_on_ice = [&]() {
      const int32_t support = support_at(x, y, z - 1);
      return support >= 0 && IsIceRole(voxels[support].role);
    }();
    const int32_t target_x = x + dx;
    const int32_t target_y = y + dy;
    if (!IsInsideRoom(target_x, target_y, width, height)) break;

    const int32_t target = FindVoxelAt(
        voxels, target_x, target_y, z, width, height);
    if (target >= 0 && target != player_index) {
      const int32_t target_object = g_voxel_object[target];
      if (!automatic_ice_motion && target_object >= 0) {
        // Reject only collisions that no carrier/chain rule can rescue. This
        // avoids entering the full multi-body kernel for pushes directly into
        // room boundaries or immutable terrain while leaving every ambiguous
        // dynamic interaction to that kernel.
        bool definitely_blocked = false;
        for (int32_t member = g_object_head[target_object]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t member_x = voxels[member].x + dx;
          const int32_t member_y = voxels[member].y + dy;
          if (!IsInsideRoom(member_x, member_y, width, height)) {
            definitely_blocked = true;
            break;
          }
          const int32_t occupant = FindVoxelAt(
              voxels,
              member_x,
              member_y,
              voxels[member].z,
              width,
              height);
          if (occupant >= 0 && occupant != player_index &&
              g_voxel_object[occupant] < 0) {
            definitely_blocked = true;
            break;
          }
        }
        if (!definitely_blocked) {
          g_ignored_support_voxel = -1;
          return 0;
        }
        break;
      }
      break;
    }

    const int32_t direct_support = support_at(target_x, target_y, z - 1);
    if (direct_support < 0) {
      const int32_t lower_support = FindNearestVoxelBelow(
          voxels, count, target_x, target_y, z, -1, width);
      const int32_t current_support = support_at(x, y, z - 1);
      const bool may_leave_support = automatic_ice_motion || started_on_ice ||
          (current_support >= 0 &&
           voxels[current_support].role == kFloorRole && lower_support < 0);
      if (!may_leave_support) break;
    }

    x = target_x;
    y = target_y;
    if (direct_support < 0) {
      fall_until_settled();
      break;
    }

    const bool now_on_ice = IsIceRole(voxels[direct_support].role);
    if (now_on_ice) {
      automatic_ice_motion = true;
      continue;
    }
    if (automatic_ice_motion) break;

    break;
  }

  player.x = x;
  player.y = y;
  player.z = z;
  CollectGoalsAtPlayer(voxels, count, player_index, width, height);
  g_ignored_support_voxel = -1;
  return 1;
}
