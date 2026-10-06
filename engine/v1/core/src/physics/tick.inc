namespace {

bool IsCommandActorObject(int32_t object) {
  return object >= 0 &&
      (g_object_kind[object] == kCloneObject ||
       g_object_kind[object] == kPlayerObject);
}

// Clone components resolve from front to back, so one may reach the player's
// current cell before the player's own command is evaluated. Validate the
// player's local entry and push proposal without committing it; a clone may
// treat that cell as vacated only when the complete push transaction can
// actually succeed.
bool PlayerWillVacateForCloneCommand(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t direction,
    int32_t width,
    int32_t height) {
  if (player_index < 0 ||
      !ObjectIsActive(voxels, g_voxel_object[player_index], width, height)) {
    // A one-voxel player intentionally has no rigid-object record.
    if (player_index < 0 ||
        !IsInsideRoom(
            voxels[player_index].x, voxels[player_index].y, width, height)) {
      return false;
    }
  } else if (g_object_kind[g_voxel_object[player_index]] == kPlayerObject) {
    return true;
  }
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const Voxel& player = voxels[player_index];
  const int32_t dx = kDx[direction];
  const int32_t dy = kDy[direction];
  const int32_t target_x = player.x + dx;
  const int32_t target_y = player.y + dy;
  if (!IsInsideRoom(target_x, target_y, width, height)) return false;
  const int32_t dz = DeliberateSlopeVerticalDelta(
      voxels, player, direction, width, height, false);
  if (SlopeEntryIsBlocked(voxels, player, direction, dz, width, height, false)) {
    return false;
  }
  const int32_t target_z = player.z + dz;
  // Use the player's actual local ramp proposal. An unrelated ramp elsewhere
  // in the room cannot waive this collision check for every trailing clone.
  const int32_t target = FindVoxelAt(
      voxels, target_x, target_y, target_z, width, height);
  if (target >= 0) {
    const int32_t object = g_voxel_object[target];
    if (object < 0) return false;
    if (IsCommandActorObject(object)) return true;
    if (g_object_kind[object] != kNormalObject &&
        g_object_kind[object] != kWeightlessObject) {
      return false;
    }
    ClearMovingObjects();
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>(direction);
    const bool can_move = TranslateMovingObjects(
        voxels,
        count,
        player_index,
        dx,
        dy,
        0,
        width,
        height,
        true,
        true,
        true,
        false,
        false);
    ClearMovingObjects();
    return can_move;
  }

  if (target_z == INT32_MIN) return false;
  const int32_t direct_support = FindVoxelAt(
      voxels, target_x, target_y, target_z - 1, width, height);
  if (direct_support >= 0) {
    return voxels[direct_support].role != kFloatingFloorRole;
  }
  const int32_t current_support = FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height);
  const int32_t lower_support = FindNearestVoxelBelow(
      voxels, count, target_x, target_y, target_z, -1, width);
  return current_support >= 0 &&
      (voxels[current_support].role == kFloorRole ||
       IsIceRole(voxels[current_support].role)) &&
      lower_support < 0;
}

// Clone IDs and a multi-voxel player are command-controlled rigid polycubes.
// They all receive the input, but a blocked actor must not cancel another
// actor. Destination-linked actors form one simultaneous
// proposal component; unrelated components resolve front-first so vacated
// cells become available without imposing a level-wide all-or-nothing move.
bool AdvanceCloneCommandObjects(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t direction,
    int32_t width,
    int32_t height) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t dx = kDx[direction];
  const int32_t dy = kDy[direction];
  ActiveWorkspace().clone_command_tick_active = true;
  bool has_clone = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_clone_command_moved[object] = 0;
    g_clone_command_processed[object] = 0;
    has_clone |= IsCommandActorObject(object) &&
        ObjectIsActive(voxels, object, width, height);
  }
  if (!has_clone) {
    ActiveWorkspace().clone_command_tick_active = false;
    return false;
  }
  const bool player_will_vacate = PlayerWillVacateForCloneCommand(
      voxels, count, player_index, direction, width, height);

  bool advanced = false;
  for (;;) {
    int32_t next_object = -1;
    int64_t next_front = INT64_MIN;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!IsCommandActorObject(object) ||
          g_clone_command_processed[object] != 0 ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      int64_t front = INT64_MIN;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const int64_t projection =
            static_cast<int64_t>(voxels[member].x) * dx +
            static_cast<int64_t>(voxels[member].y) * dy;
        if (projection > front) front = projection;
      }
      if (front > next_front) {
        next_front = front;
        next_object = object;
      }
    }
    if (next_object < 0) break;

    for (int32_t object = 0; object < g_object_count; ++object) {
      g_component_objects[object] = 0;
    }
    int32_t queue_begin = 0;
    int32_t queue_end = 0;
    g_component_objects[next_object] = 1;
    g_object_queue[queue_end++] = next_object;
    while (queue_begin < queue_end) {
      const int32_t object = g_object_queue[queue_begin++];
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const int32_t occupant = FindVoxelAt(
            voxels,
            voxels[member].x + dx,
            voxels[member].y + dy,
            voxels[member].z,
            width,
            height);
        const int32_t other = occupant >= 0
            ? g_voxel_object[occupant]
            : -1;
        if (other < 0 || other == object ||
            !IsCommandActorObject(other) ||
            g_clone_command_processed[other] != 0 ||
            g_component_objects[other] != 0) {
          continue;
        }
        g_component_objects[other] = 1;
        g_object_queue[queue_end++] = other;
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] != 0) {
        g_clone_command_processed[object] = 1;
      }
    }

    // Like the player, a clone may deliberately walk off Floor or Ice but not
    // step away from the top of a wall into unsupported space. A polycube is
    // anchored only by external rigid terrain; support from the player or a
    // movable body participates in the normal simultaneous carrier rules.
    bool ledge_blocked = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] == 0) continue;
      bool has_rigid_foothold = false;
      bool has_destination_support = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        if (voxel.z == INT32_MIN) continue;
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support >= 0 && support != player_index &&
            g_voxel_object[support] != object &&
            g_voxel_object[support] < 0 &&
            !IsIceRole(voxels[support].role) &&
            voxels[support].role != kFloorRole) {
          has_rigid_foothold = true;
        }
        const int32_t destination_support = FindVoxelAt(
            voxels,
            voxel.x + dx,
            voxel.y + dy,
            voxel.z - 1,
            width,
            height);
        const int32_t support_object = destination_support >= 0
            ? g_voxel_object[destination_support]
            : -1;
        if (destination_support >= 0 && destination_support != player_index &&
            voxels[destination_support].role != kFloatingFloorRole &&
            support_object != object &&
            (support_object < 0 || g_component_objects[support_object] == 0)) {
          has_destination_support = true;
        }
      }
      ledge_blocked |= has_rigid_foothold && !has_destination_support;
    }
    if (ledge_blocked) continue;

    ClearMovingObjects();
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] == 0) continue;
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      g_object_direction[object] = static_cast<uint8_t>(direction);
    }
    bool player_was_pushed = false;
    const bool moved = SceneHasIceSlopes(voxels, count, width, height)
        ? TranslateSlopeMomentumObjects(
              voxels,
              count,
              player_index,
              width,
              height,
              true,
              false,
              true,
              player_will_vacate,
              player_was_pushed)
        : TranslateMovingObjects(
              voxels,
              count,
              player_index,
              dx,
              dy,
              0,
              width,
              height,
              false,
              true,
              player_will_vacate,
              false);
    if (!moved) continue;
    advanced = true;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] != 0) {
        g_clone_command_moved[object] = 1;
      }
    }
  }

  ClearMovingObjects();
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_clone_command_moved[object] == 0) continue;
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = g_inherited_support_motion[object] != 0
        ? static_cast<uint8_t>(g_inherited_support_motion[object] - 1)
        : static_cast<uint8_t>(direction);
  }
  (void)StoreSupportedMandatoryMomentum(
      state, voxels, count, width, height, direction);
  return advanced;
}

bool AppendCloneCommandMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t direction,
    int32_t width,
    int32_t height) {
  bool stored = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_clone_command_moved[object] == 0 ||
        !ObjectIsActive(voxels, object, width, height) ||
        !ObjectIsFullyOnIce(voxels, object, width, height)) {
      continue;
    }
    stored = true;
    const uint8_t momentum = g_inherited_support_motion[object] != 0
        ? g_inherited_support_motion[object]
        : static_cast<uint8_t>(direction + 1);
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->horizontal_momentum[member] = momentum;
    }
  }
  return stored;
}

bool HasSupportedObjectMomentum(
    const MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    const uint8_t momentum = ReadObjectMomentum(
        state->horizontal_momentum, object);
    if ((IsPunchMomentum(momentum) ||
         (momentum > 0 && momentum <= 4 &&
          ObjectIsFullyOnIce(voxels, object, width, height))) &&
        ObjectIsActive(voxels, object, width, height) &&
        g_object_kind[object] != kMechanismObject) {
      return true;
    }
  }
  return false;
}

bool SceneHasCommandActorObject() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (IsCommandActorObject(object)) return true;
  }
  return false;
}

}  // namespace

TickResult step_tick(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  if (workspace == nullptr || state == nullptr) return TickResult::kInvalid;
  WorkspaceScope workspace_scope(workspace);
  const int64_t cell_count = static_cast<int64_t>(width) * height;
  if (voxels == nullptr || count < 0 || count > kVoxelCapacity || width <= 0 ||
      height <= 0 || cell_count > UINT32_MAX || direction < 0 || direction > 3 ||
      state->version != kMotionStateVersion) {
    return TickResult::kInvalid;
  }
  if (state->phase == kMotionComplete) return TickResult::kComplete;

  const bool initialized_this_call = state->direction < 0;
  bool workspace_has_continuation =
      ActiveWorkspace().continuation_state == state &&
      ActiveWorkspace().continuation_voxels == voxels &&
      ActiveWorkspace().continuation_tick == state->tick;
  if (state->direction < 0) {
    const bool prepared = IsPreparedScene(voxels, count, width, height);
    int32_t player_index = prepared
        ? ActiveWorkspace().prepared_player_index
        : -1;
    if (!prepared) {
      for (int32_t index = 0; index < count; ++index) {
        if (voxels[index].role == kPlayerRole) {
          player_index = index;
          break;
        }
      }
    }
    if (player_index < 0) return TickResult::kNoPlayer;
    if (IsPreparedScene(voxels, count, width, height)) {
      ResetObjectMotion();
    } else {
      BuildObjects(voxels, count);
    }
    BuildSpatialIndex(voxels, count, width, height);
    if (NormalizeInitialOrangeWallAnchors(
            voxels, count, width, height)) {
      BuildSpatialIndex(voxels, count, width, height);
    }
    if (prepared && ActiveWorkspace().assume_quiescent_start) {
      ActiveWorkspace().assume_quiescent_start = false;
      InitializeQuiescentMotion(state, count, player_index, direction);
    } else {
      ActiveWorkspace().assume_quiescent_start = false;
      InitializeMotion(
          state, voxels, count, width, height, player_index, direction);
    }
    workspace_has_continuation = true;
  } else if (state->voxel_count != count || state->player_index < 0 ||
             state->player_index >= count ||
             voxels[state->player_index].role != kPlayerRole) {
    return TickResult::kInvalid;
  }

  const int32_t player_index = state->player_index;
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  int32_t dx = kDx[state->direction];
  int32_t dy = kDy[state->direction];

  if (!workspace_has_continuation) {
    BuildObjects(voxels, count);
    BuildSpatialIndex(voxels, count, width, height);
    LoadObjectMotion(state);
  }
  bool puncher_visual_advanced = false;
  bool player_punch_activated_this_tick = false;
  if (!initialized_this_call) {
    puncher_visual_advanced = ResetSprungPunchers(voxels);
  }
  // A ready command starts from a resting board, which may already overlap a
  // blocked puncher. Let the input move first; store_and_finish discovers the
  // resulting contact and schedules its punch on the following tick.
  if (IsPlayerPunchPhase(state->phase) ||
      state->phase == kMotionObjectIce) {
    const PuncherContact activated = ActivatePunchers(
        state, voxels, state->player_index, width, height);
    puncher_visual_advanced |= activated.player || activated.object;
    if (activated.player) {
      player_punch_activated_this_tick = true;
      state->phase = kMotionPlayerPunch;
      state->direction = activated.player_direction;
      dx = kDx[state->direction];
      dy = kDy[state->direction];
    } else if (activated.object) {
      state->phase = kMotionObjectIce;
    }
  }
  const int32_t player_object = g_voxel_object[player_index];
  const bool player_is_rigid_object =
      player_object >= 0 && g_object_kind[player_object] == kPlayerObject;

  const bool clone_command_tick = state->phase == kMotionReady;
  const bool clone_command_advanced = clone_command_tick &&
      AdvanceCloneCommandObjects(
          state,
          voxels,
          count,
          player_index,
          state->direction,
          width,
          height);

  bool orange_advanced_this_tick = false;
  bool gate_advanced_this_tick = false;
  auto store_and_finish = [&](int32_t phase,
                              bool advanced,
                              bool gravity_already_checked = false) {
    advanced |= orange_advanced_this_tick || clone_command_advanced ||
        puncher_visual_advanced || gate_advanced_this_tick;
    if (clone_command_tick) {
      (void)AppendCloneCommandMomentum(
          state, voxels, state->direction, width, height);
    }
    const bool object_momentum_pending = SceneHasCommandActorObject() &&
        HasSupportedObjectMomentum(state, voxels, width, height);
    if (phase == kMotionGravity && object_momentum_pending &&
        state->reserved[0] != kResumeCommand) {
      state->reserved[0] = kResumeObjectIce;
    } else if ((phase == kMotionComplete || phase == kMotionPlayerIce) &&
               object_momentum_pending) {
      // Object-Ice advances every independently sliding clone and also folds
      // in the player's own Ice proposal when both exist in the same tick.
      phase = kMotionObjectIce;
    }
    if (phase == kMotionComplete && !gravity_already_checked &&
        ObjectsNeedGravityTick(voxels, count, width, height)) {
      // A blocked/boundary-ending Ice proposal can happen immediately after a
      // carried body lost support. Completion must still drain that gravity;
      // otherwise the body remains suspended until the next player command.
      phase = kMotionGravity;
      state->reserved[0] = kResumeNothing;
    }
    if (phase == kMotionComplete &&
        PlayerGatesNeedTick(voxels, count, width, height)) {
      phase = kMotionPlayerGates;
    }
    if (phase == kMotionComplete &&
        OrangeMechanismsNeedTick(voxels, count, width, height)) {
      if (state->phase != kMotionOrangeMechanisms) {
        state->reserved[1] = static_cast<uint8_t>(phase);
      }
      phase = kMotionOrangeMechanisms;
    }
    const PuncherContact pending_punch = FindPuncherContacts(
        voxels,
        state->player_index,
        width,
        height,
        phase != kMotionComplete);
    if (pending_punch.player) {
      phase = kMotionPlayerPunch;
      state->direction = pending_punch.player_direction;
    } else if (pending_punch.object) {
      phase = kMotionObjectIce;
    }
    if (phase == kMotionComplete && IsPlayerPunchPhase(state->phase) &&
        !player_is_rigid_object) {
      const Voxel& punched_player = voxels[state->player_index];
      if (IsInsideRoom(
              punched_player.x, punched_player.y, width, height) &&
          punched_player.z != INT32_MIN &&
          FindVoxelAt(
              voxels,
              punched_player.x,
              punched_player.y,
              punched_player.z - 1,
              width,
              height) < 0 &&
          state->player_gravity_armed != 0) {
        state->player_falling = 1;
        state->reserved[0] = kResumeNothing;
        phase = kMotionGravity;
      }
    }
    state->phase = phase;
    if (advanced) ++state->tick;
    if (phase == kMotionComplete) {
      CollectGoalsAtActors(
          voxels, count, state->player_index, width, height);
    }
    StoreObjectMotion(state, count);
    ActiveWorkspace().clone_command_tick_active = false;
    if (phase == kMotionComplete) {
      ActiveWorkspace().continuation_state = nullptr;
      ActiveWorkspace().continuation_voxels = nullptr;
      ActiveWorkspace().continuation_tick = -1;
      ClearHorizontalMomentum(state, count);
      return TickResult::kComplete;
    }
    ActiveWorkspace().continuation_state = state;
    ActiveWorkspace().continuation_voxels = voxels;
    ActiveWorkspace().continuation_tick = state->tick;
    return TickResult::kMore;
  };

  auto resolve_player_gravity = [&](bool automatic_ice_motion,
                                    bool started_on_ice,
                                    bool pushed) {
    if (player_is_rigid_object) {
      state->player_falling = 0;
      return false;
    }
    Voxel& player = voxels[player_index];
    if (!IsInsideRoom(player.x, player.y, width, height)) {
      state->player_falling = 0;
      return false;
    }
    if (player.z != INT32_MIN &&
        FindVoxelAt(voxels, player.x, player.y, player.z - 1, width, height) >= 0) {
      state->player_gravity_armed = 1;
      state->player_falling = 0;
      return false;
    }
    const int32_t lower_support = FindNearestVoxelBelow(
        voxels, count, player.x, player.y, player.z, -1, width);
    if (lower_support < 0) {
      if (!state->player_gravity_armed) return false;
    } else if (!automatic_ice_motion && !started_on_ice && !pushed &&
               !state->player_falling) {
      return false;
    }

    const int32_t previous_z = player.z;
    state->player_gravity_armed = 1;
    state->player_falling = 1;
    if (player.z == INT32_MIN) {
      player.x = -1;
      state->player_falling = 0;
    } else {
      --player.z;
      if (lower_support < 0 && previous_z < LowestOtherActiveZ(
              voxels, count, width, height, -1, player_index, false, true)) {
        // Keep the player visible until its top has passed below every other
        // active voxel. On the following unsupported step, advance once more
        // and remove it from the room.
        player.x = -1;
        state->player_falling = 0;
      }
    }
    BuildSpatialIndex(voxels, count, width, height);
    if (IsInsideRoom(player.x, player.y, width, height) &&
        player.z != INT32_MIN &&
        FindVoxelAt(voxels, player.x, player.y, player.z - 1, width, height) >= 0) {
      state->player_falling = 0;
    }
    return true;
  };

  auto defer_player_gravity = [&](bool automatic_ice_motion,
                                  bool started_on_ice,
                                  bool pushed) {
    if (player_is_rigid_object) {
      state->player_falling = 0;
      return false;
    }
    const Voxel& player = voxels[player_index];
    if (!IsInsideRoom(player.x, player.y, width, height)) {
      state->player_falling = 0;
      return false;
    }
    if (player.z != INT32_MIN &&
        FindVoxelAt(
            voxels, player.x, player.y, player.z - 1, width, height) >= 0) {
      state->player_gravity_armed = 1;
      state->player_falling = 0;
      return false;
    }
    const int32_t lower_support = FindNearestVoxelBelow(
        voxels, count, player.x, player.y, player.z, -1, width);
    if (lower_support < 0) {
      if (!state->player_gravity_armed) return false;
    } else if (!automatic_ice_motion && !started_on_ice && !pushed &&
               state->player_falling == 0) {
      return false;
    }
    state->player_gravity_armed = 1;
    state->player_falling = 1;
    return true;
  };

  // Gate proximity is sampled from the previous animation frame. During
  // continuous Ice/gravity motion, the gate update shares the following
  // movement tick. Once other motion stops, a dedicated final mechanism tick
  // exposes the same one-frame delay.
  if (!initialized_this_call &&
      (state->phase == kMotionPlayerGates ||
       PlayerGatesNeedTick(voxels, count, width, height))) {
    const bool dedicated_gate_tick = state->phase == kMotionPlayerGates;
    gate_advanced_this_tick = RefreshPlayerGates(
        voxels, count, width, height);
    if (gate_advanced_this_tick) {
      BuildSpatialIndex(voxels, count, width, height);
      MarkObjectsForDeferredGravity(voxels, width, height, false);
      state->player_gravity_armed = 1;
    }
    if (dedicated_gate_tick) {
      return store_and_finish(kMotionComplete, false);
    }
  }

  // Orange walls react one tick after the pressure change. While another
  // motion phase is still active (Ice, gravity, or a lift), their one-row
  // update shares that next animation tick instead of inserting a pause in
  // the moving body. A quiescent command still drains any remaining wall
  // rows as ordinary standalone ticks.
  if (!initialized_this_call &&
      (state->phase == kMotionOrangeMechanisms ||
       OrangeMechanismsNeedTick(voxels, count, width, height))) {
    const int32_t resume_phase = state->phase == kMotionOrangeMechanisms
        ? state->reserved[1]
        : state->phase;
    orange_advanced_this_tick = AdvanceOrangeMechanismsOneTick(
        state, voxels, count, player_index, width, height);
    state->phase = resume_phase;
    if (resume_phase == kMotionComplete) {
      bool lift_will_raise = false;
      const int32_t lift_index = PlayerLiftAtPlayer(
          voxels,
          count,
          player_index,
          width,
          height,
          lift_will_raise);
      const int32_t lift_object = lift_index >= 0
          ? g_voxel_object[lift_index]
          : -1;
      if (orange_advanced_this_tick && lift_object >= 0 &&
          g_clone_command_processed[lift_object] != 0) {
        return store_and_finish(kMotionPlayerLift, false, true);
      }
      return store_and_finish(kMotionComplete, false);
    }
  }

  if (state->phase == kMotionPlayerLift) {
    if (state->reserved[0] == kResumeVacatedLift) {
      const Voxel& player = voxels[player_index];
      const int32_t from_x = player.x - dx;
      const int32_t from_y = player.y - dy;
      const int32_t from_z = player.z;
      state->reserved[0] = kResumeNothing;
      const bool raised = RaiseVacatedUpwardPlayerLift(
          voxels,
          count,
          player_index,
          from_x,
          from_y,
          from_z,
          true);
      if (raised) {
        (void)RefreshOrangeButtonVisibility(voxels, count);
      }
      BuildSpatialIndex(voxels, count, width, height);
      MarkObjectsForDeferredGravity(voxels, width, height, false);
      const bool entry_lift_pending = PlayerLiftCanToggleOnEntry(
          voxels,
          count,
          player_index,
          from_x,
          from_y,
          width,
          height);
      const bool gravity_continues = ObjectsNeedGravityTick(
          voxels, count, width, height, false);
      return store_and_finish(
          entry_lift_pending
              ? kMotionPlayerLift
              : gravity_continues ? kMotionGravity : kMotionComplete,
          raised,
          true);
    }
    bool lift_will_raise = false;
    const int32_t lift_index = PlayerLiftAtPlayer(
        voxels,
        count,
        player_index,
        width,
        height,
        lift_will_raise);
    const int32_t lift_count = PlayerLiftCountAtPlayer(
        voxels, count, player_index, width, height);
    const int32_t outward = lift_count == 1 && lift_index >= 0 &&
            lift_will_raise
        ? PlayerLiftSideOutwardDirection(voxels[lift_index])
        : -1;
    const bool toggled = TogglePlayerLiftAtPlayer(
        voxels, count, player_index, width, height);
    if (toggled) {
      (void)RefreshOrangeButtonVisibility(voxels, count);
    }
    BuildSpatialIndex(voxels, count, width, height);
    MarkObjectsForDeferredGravity(voxels, width, height, false);
    const bool object_gravity_continues = ObjectsNeedGravityTick(
        voxels, count, width, height, false);
    bool player_gravity_continues = false;
    bool player_ice_continues = false;
    if (toggled && outward >= 0) {
      // A side lift imparts its outward direction to the rider. That proposal
      // continues naturally across Ice, while an unsupported ejection drains
      // vertical gravity before the command completes.
      state->direction = outward;
      dx = kDx[outward];
      dy = kDy[outward];
      player_gravity_continues = defer_player_gravity(true, false, false);
      player_ice_continues = !player_gravity_continues &&
          IsSupportedByIce(voxels, voxels[player_index], width, height);
    }
    const bool gravity_continues =
        object_gravity_continues || player_gravity_continues;
    return store_and_finish(
        gravity_continues
            ? kMotionGravity
            : player_ice_continues ? kMotionPlayerIce : kMotionComplete,
        toggled,
        true);
  }

  if (state->phase == kMotionGravity) {
    const bool player_has_horizontal_ice_proposal =
        state->reserved[0] == kResumePlayerIce &&
        IsSupportedByIce(voxels, voxels[player_index], width, height);
    bool player_slid = false;
    bool player_lift_pending = false;
    bool horizontal_proposal_caught_falling_body = false;
    if (player_has_horizontal_ice_proposal) {
      Voxel& sliding_player = voxels[player_index];
      const int32_t next_x = sliding_player.x + dx;
      const int32_t next_y = sliding_player.y + dy;
      const int32_t next_z = sliding_player.z;
      const int32_t current_target = IsInsideRoom(
          next_x, next_y, width, height)
          ? FindVoxelAt(voxels, next_x, next_y, next_z, width, height)
          : -1;
      const int32_t falling_above = next_z == INT32_MAX
          ? -1
          : FindVoxelAt(
                voxels, next_x, next_y, next_z + 1, width, height);
      const int32_t falling_object = falling_above >= 0
          ? g_voxel_object[falling_above]
          : -1;
      if (current_target < 0 && falling_object >= 0 &&
          g_object_falling[falling_object] != 0) {
        const int32_t slide_from_x = sliding_player.x;
        const int32_t slide_from_y = sliding_player.y;
        const int32_t slide_from_z = sliding_player.z;
        TranslateObjectsCarriedByPlayerOneStep(
            voxels, player_index, dx, dy, width, height);
        sliding_player.x = next_x;
        sliding_player.y = next_y;
        (void)RaiseVacatedUpwardPlayerLift(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            slide_from_z,
            false);
        player_lift_pending = PlayerLiftCanToggleOnEntry(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            width,
            height);
        player_slid = true;
        horizontal_proposal_caught_falling_body = true;
        BuildSpatialIndex(voxels, count, width, height);
        defer_player_gravity(true, true, false);
        if (!IsSupportedByIce(
                voxels, sliding_player, width, height)) {
          state->reserved[0] = kResumeNothing;
        }
      }
    }
    int32_t object_supported_by_player = -1;
    const Voxel& player_before_gravity = voxels[player_index];
    if (player_before_gravity.z != INT32_MAX) {
      const int32_t above_player = FindVoxelAt(
          voxels,
          player_before_gravity.x,
          player_before_gravity.y,
          player_before_gravity.z + 1,
          width,
          height);
      if (above_player >= 0) {
        object_supported_by_player = g_voxel_object[above_player];
      }
    }
    const RiderSnapshot rider =
        CapturePlayerRider(voxels, player_index, width, height);
    if (rider.object >= 0 ||
        (!horizontal_proposal_caught_falling_body &&
         object_supported_by_player >= 0 && state->player_falling != 0)) {
      g_ignored_support_voxel = player_index;
    }
    SettleAllObjects(voxels, count, width, height);
    g_ignored_support_voxel = -1;
    const bool objects_advanced = ObjectsAdvancedThisTick();
    const bool rode_falling_object =
        rider.object >= 0 && g_fell_objects[rider.object] != 0;
    bool player_rode_falling_object = false;
    if (rode_falling_object) {
      player_rode_falling_object = MovePlayerWithRider(
          voxels, player_index, rider, width, height);
      BuildSpatialIndex(voxels, count, width, height);
    }
    if (!player_slid && !player_rode_falling_object &&
        player_has_horizontal_ice_proposal) {
      Voxel& sliding_player = voxels[player_index];
      const int32_t next_x = sliding_player.x + dx;
      const int32_t next_y = sliding_player.y + dy;
      if (IsInsideRoom(next_x, next_y, width, height) &&
          FindVoxelAt(
              voxels,
              next_x,
              next_y,
              sliding_player.z,
              width,
              height) < 0) {
        const int32_t slide_from_x = sliding_player.x;
        const int32_t slide_from_y = sliding_player.y;
        const int32_t slide_from_z = sliding_player.z;
        TranslateObjectsCarriedByPlayerOneStep(
            voxels, player_index, dx, dy, width, height);
        sliding_player.x = next_x;
        sliding_player.y = next_y;
        (void)RaiseVacatedUpwardPlayerLift(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            slide_from_z,
            false);
        player_lift_pending = PlayerLiftCanToggleOnEntry(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            width,
            height);
        player_slid = true;
        BuildSpatialIndex(voxels, count, width, height);
        defer_player_gravity(true, true, false);
        if (!IsSupportedByIce(
                voxels, sliding_player, width, height)) {
          state->reserved[0] = kResumeNothing;
        }
      } else {
        // The body that just fell may still occupy this elevation (for
        // example, a tall polycube). A blocked horizontal proposal spends the
        // player's Ice momentum rather than resuming after the fall finishes.
        state->reserved[0] = kResumeNothing;
      }
    }
    const bool player_fell = player_slid
        ? false
        : resolve_player_gravity(true, false, false);
    const bool player_advanced =
        player_rode_falling_object || player_slid || player_fell;
    if (player_lift_pending) {
      return store_and_finish(kMotionPlayerLift, player_advanced, true);
    }
    if (player_fell && object_supported_by_player >= 0 &&
        ObjectIsActive(
            voxels, object_supported_by_player, width, height) &&
        !ObjectHasDirectSupport(
            voxels, object_supported_by_player, width, height)) {
      g_object_gravity_armed[object_supported_by_player] = 1;
      g_object_falling[object_supported_by_player] = 1;
    }
    const bool gravity_continues =
        state->player_falling != 0 ||
        ObjectsNeedGravityTick(voxels, count, width, height, false);
    if (!gravity_continues && state->reserved[0] == kResumeCommand) {
      state->reserved[0] = kResumeNothing;
      return store_and_finish(
          kMotionReady, objects_advanced || player_advanced);
    }
    if (!gravity_continues && state->reserved[0] == kResumeObjectIce) {
      state->reserved[0] = kResumeNothing;
      RestoreMandatoryMomentum(state, voxels, width, height);
      CancelConflictingLandedSlopeMomentum(
          state, voxels, width, height);
      if (MovingObjectsAreFullyOnIce(voxels, width, height)) {
        return store_and_finish(
            kMotionObjectIce, objects_advanced || player_advanced);
      }
      ClearHorizontalMomentum(state, count);
      return store_and_finish(
          kMotionComplete, objects_advanced || player_advanced, true);
    }
    if (!gravity_continues && state->reserved[0] == kResumePlayerIce &&
        IsSupportedByIce(voxels, voxels[player_index], width, height)) {
      state->reserved[0] = kResumeNothing;
      return store_and_finish(
          kMotionPlayerIce, objects_advanced || player_advanced);
    }
    if (!gravity_continues) state->reserved[0] = kResumeNothing;
    return store_and_finish(
        gravity_continues ? kMotionGravity : kMotionComplete,
        objects_advanced || player_advanced,
        true);
  }

  if (state->phase == kMotionObjectIce) {
    const bool punch_object_momentum = HasPunchObjectMomentum(
        state, voxels, width, height);
    RestoreMandatoryMomentum(state, voxels, width, height);
    for (int32_t object = 0; object < g_object_count; ++object) {
      // Deferred activation is a one-tick scheduling aid. Once it has been
      // serialized as horizontal momentum, the resumed body is an ordinary
      // mandatory proposal and must no longer be suppressed.
      g_deferred_slope_objects[object] = 0;
    }
    const bool slope_scene = SceneHasIceSlopes(
        voxels, count, width, height);
    const bool directional_object_motion =
        slope_scene || punch_object_momentum;
    if (!directional_object_motion) {
      state->direction = RedirectMovingObjectSlopeDirection(
          voxels, state->direction, width, height);
      dx = kDx[state->direction];
      dy = kDy[state->direction];
    }
    const int32_t object_dz = directional_object_motion
        ? 0
        : MovingObjectSlopeVerticalDelta(
              voxels, state->direction, width, height);
    const bool player_has_ice_momentum = !player_is_rigid_object &&
        state->reserved[1] == 0 &&
        IsSupportedByIce(voxels, voxels[player_index], width, height);
    const RiderSnapshot rider =
        CapturePlayerRider(voxels, player_index, width, height);
    const bool player_vacates_vertically = !player_has_ice_momentum &&
        rider.object < 0 && voxels[player_index].z != INT32_MIN &&
        state->player_gravity_armed != 0 &&
        FindVoxelAt(
            voxels,
            voxels[player_index].x,
            voxels[player_index].y,
            voxels[player_index].z - 1,
            width,
            height) < 0;
    int32_t player_ice_direction = state->direction;
    int32_t player_ice_dx = dx;
    int32_t player_ice_dy = dy;
    int32_t player_ice_dz = 0;
    int32_t player_ice_leader_object = -1;
    if (player_has_ice_momentum) {
      player_ice_direction = RedirectSlopeDirection(
          voxels,
          voxels[player_index],
          state->direction,
          width,
          height);
      player_ice_dx = kDx[player_ice_direction];
      player_ice_dy = kDy[player_ice_direction];
      player_ice_dz = SlopeVerticalDelta(
          voxels,
          voxels[player_index],
          player_ice_direction,
          width,
          height);
      const Voxel& sliding_player = voxels[player_index];
      const int32_t leader_voxel = FindVoxelAt(
          voxels,
          sliding_player.x + player_ice_dx,
          sliding_player.y + player_ice_dy,
          sliding_player.z + player_ice_dz,
          width,
          height);
      player_ice_leader_object = leader_voxel >= 0
          ? g_voxel_object[leader_voxel]
          : -1;
      if (player_ice_leader_object >= 0 &&
          g_object_kind[player_ice_leader_object] == kWeightlessObject) {
        const uint8_t leader_momentum = ReadObjectMomentum(
            state->horizontal_momentum, player_ice_leader_object);
        if (leader_momentum > 4 &&
            ((leader_momentum - 1) & 3) == player_ice_direction) {
          // A body pushed on the preceding Ice tick can temporarily gain a
          // non-Ice contact from a different moving body. Its latent momentum
          // still participates when the sliding player is immediately behind
          // it, so all independent axes resolve in this same discrete tick.
          g_mandatory_objects[player_ice_leader_object] = 1;
          g_moving_objects[player_ice_leader_object] = 1;
          g_object_direction[player_ice_leader_object] =
              static_cast<uint8_t>(player_ice_direction);
        }
      }
    }
    g_ignored_support_voxel = player_index;
    bool player_was_pushed = false;
    const bool translated = directional_object_motion
        ? TranslateSlopeMomentumObjects(
              voxels,
              count,
              player_index,
              width,
              height,
              false,
              false,
              true,
              player_has_ice_momentum || rider.object >= 0 ||
                  player_vacates_vertically,
              player_was_pushed)
        : TranslateMovingObjects(
              voxels,
              count,
              player_index,
              dx,
              dy,
              object_dz,
              width,
              height,
              true,
              false,
              player_has_ice_momentum || rider.object >= 0 ||
                  player_vacates_vertically);
    g_ignored_support_voxel = -1;
    if (!translated) {
      MarkObjectsForDeferredGravity(voxels, width, height, false);
      defer_player_gravity(false, false, true);
      const bool gravity_continues =
          state->player_falling != 0 ||
          ObjectsNeedGravityTick(voxels, count, width, height, false);
      if (gravity_continues) {
        state->reserved[0] = StoredMomentumWillLandOnSlope(
            state, voxels, count, width)
            ? kResumeObjectIce
            : kResumeNothing;
      }
      return store_and_finish(
          gravity_continues ? kMotionGravity : kMotionComplete,
          ObjectsAdvancedThisTick(),
          true);
    }

    if (punch_object_momentum) {
      // A punch is an inertial horizontal impulse, not an Ice-only slide.
      // Unsupported punched bodies keep advancing horizontally at one cell
      // per tick and begin falling only when their horizontal proposal is
      // blocked. This also gives simultaneous horizontal and vertical motion
      // a deterministic priority: the punch owns the cell first.
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (!IsPunchMomentum(ReadObjectMomentum(
                state->horizontal_momentum, object))) {
          continue;
        }
        g_object_falling[object] = 0;
      }
    }

    if (player_has_ice_momentum && player_ice_leader_object >= 0 &&
        g_mandatory_objects[player_ice_leader_object] != 0 &&
        g_object_redirected[player_ice_leader_object] != 0) {
      player_ice_direction = g_object_direction[player_ice_leader_object];
      player_ice_dx = kDx[player_ice_direction];
      player_ice_dy = kDy[player_ice_direction];
      player_ice_dz = SlopeVerticalDelta(
          voxels,
          voxels[player_index],
          player_ice_direction,
          width,
          height);
    }

    const bool player_rode_object =
        MovePlayerWithRider(voxels, player_index, rider, width, height);
    const bool player_fell_with_objects = !player_rode_object &&
        player_vacates_vertically &&
        resolve_player_gravity(false, false, true);
    bool player_moved_after_translation =
        player_rode_object || player_was_pushed || player_fell_with_objects;
    bool player_lift_pending = false;
    if (!player_rode_object && !player_was_pushed &&
        player_has_ice_momentum) {
      // A deliberate push can put both the body and the player onto Ice. From
      // then on their horizontal proposals happen in the same animation tick:
      // the body vacates its trailing cell and the player slides into it.
      // Keeping these proposals synchronized also prevents the player from
      // spuriously pushing the body an extra cell after its own delayed slide.
      Voxel& sliding_player = voxels[player_index];
      const int32_t next_x = sliding_player.x + player_ice_dx;
      const int32_t next_y = sliding_player.y + player_ice_dy;
      const int32_t next_z = sliding_player.z + player_ice_dz;
      if (IsInsideRoom(next_x, next_y, width, height) &&
          FindVoxelAt(
              voxels,
              next_x,
              next_y,
              next_z,
              width,
              height) < 0) {
        const int32_t slide_from_x = sliding_player.x;
        const int32_t slide_from_y = sliding_player.y;
        const int32_t slide_from_z = sliding_player.z;
        sliding_player.x = next_x;
        sliding_player.y = next_y;
        sliding_player.z = next_z;
        (void)RaiseVacatedUpwardPlayerLift(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            slide_from_z,
            false);
        player_lift_pending = PlayerLiftCanToggleOnEntry(
            voxels,
            count,
            player_index,
            slide_from_x,
            slide_from_y,
            width,
            height);
        state->direction = player_ice_direction;
        player_moved_after_translation = true;
      }
    }
    if (player_moved_after_translation) {
      BuildSpatialIndex(voxels, count, width, height);
    }
    if (player_lift_pending) {
      ClearHorizontalMomentum(state, count);
      return store_and_finish(kMotionPlayerLift, true, true);
    }
    if (player_was_pushed) {
      // A returning ramp convoy may finish its mandatory descent by nudging
      // the stationary player out of the destination. Contact spends the
      // convoy's remaining Ice momentum; it must not immediately begin the
      // same route again and be misclassified as a level-wide cycle.
      ClearHorizontalMomentum(state, count);
      MarkObjectsForDeferredGravity(voxels, width, height, false);
      defer_player_gravity(false, false, true);
      const bool gravity_continues =
          state->player_falling != 0 ||
          ObjectsNeedGravityTick(voxels, count, width, height, false);
      return store_and_finish(
          gravity_continues ? kMotionGravity : kMotionComplete,
          true,
          true);
    }
    if (MovingObjectsAreFullyOnIce(voxels, width, height)) {
      StoreSupportedMandatoryMomentum(
          state, voxels, count, width, height, state->direction);
      return store_and_finish(kMotionObjectIce, true);
    }

    if (punch_object_momentum) {
      StoreSupportedMandatoryMomentum(
          state, voxels, count, width, height, state->direction);
      return store_and_finish(kMotionObjectIce, true);
    }

    const bool object_momentum_remains = StoreSupportedMandatoryMomentum(
        state, voxels, count, width, height, state->direction);
    MarkObjectsForDeferredGravity(voxels, width, height, false);
    defer_player_gravity(false, false, true);
    const bool gravity_continues =
        state->player_falling != 0 ||
        ObjectsNeedGravityTick(voxels, count, width, height, false);
    if (object_momentum_remains) {
      // Bodies that remain on Ice keep moving while bodies that have left
      // support fall during the same tick. TranslateMovingObjects advances
      // gravity for those unmoved bodies, preserving one unit per axis.
      state->reserved[0] = kResumeNothing;
      return store_and_finish(kMotionObjectIce, true);
    }
    if (gravity_continues &&
        (MovingObjectWillLandOnSlope(voxels, count, width) ||
         StoredMomentumWillLandOnSlope(
             state, voxels, count, width))) {
      // Horizontal momentum pauses while a body drops onto a lower ramp. It
      // resumes only after the shared gravity phase has settled the body, at
      // which point a sideways slope may redirect it downhill.
      if (!StoredMomentumWillLandOnSlope(
              state, voxels, count, width)) {
        StoreMandatoryMomentum(
            state, voxels, count, width, height, state->direction);
      }
      state->reserved[0] = kResumeObjectIce;
    } else {
      state->reserved[0] = state->reserved[1] == 0 && IsSupportedByIce(
          voxels, voxels[player_index], width, height)
          ? kResumePlayerIce
          : kResumeNothing;
    }
    return store_and_finish(
        gravity_continues ? kMotionGravity : kMotionComplete,
        true,
        true);
  }

  const bool automatic_ice_motion = state->phase == kMotionPlayerIce;
  const bool automatic_punch_motion = IsPlayerPunchPhase(state->phase);
  const bool automatic_player_motion =
      automatic_ice_motion || automatic_punch_motion;
  const bool records_initial_tick =
      state->phase == kMotionReady && state->tick == 0;
  if (player_is_rigid_object && state->phase == kMotionReady) {
    const bool gravity_continues =
        ObjectsNeedGravityTick(voxels, count, width, height, false);
    return store_and_finish(
        gravity_continues ? kMotionGravity : kMotionComplete,
        clone_command_advanced || records_initial_tick,
        true);
  }
  Voxel& player = voxels[player_index];
  if (automatic_ice_motion || state->phase == kMotionPlayerPunch) {
    state->direction = RedirectSlopeDirection(
        voxels, player, state->direction, width, height);
    dx = kDx[state->direction];
    dy = kDy[state->direction];
  }
  const int32_t player_dz = state->phase == kMotionPlayerPunchUp
      ? 1
      : state->phase == kMotionPlayerPunchDown
          ? -1
          : automatic_player_motion
              ? SlopeVerticalDelta(
                    voxels, player, state->direction, width, height)
              : DeliberateSlopeVerticalDelta(
                    voxels, player, state->direction, width, height, false);
  if (SlopeEntryIsBlocked(
          voxels,
          player,
          state->direction,
          player_dz,
          width,
          height,
          automatic_ice_motion)) {
    return store_and_finish(kMotionComplete, records_initial_tick);
  }
  const int32_t player_from_x = player.x;
  const int32_t player_from_y = player.y;
  const int32_t player_from_z = player.z;
  const bool vacated_lift_retry_pending = !automatic_player_motion &&
      player_dz == 0 &&
      VacatedUpwardPlayerLiftNeedsRetry(
          voxels, count, player_index, width, height);
  const bool started_on_ice = IsSupportedByIce(voxels, player, width, height);
  const int32_t target_x = player.x + dx;
  const int32_t target_y = player.y + dy;
  int32_t target_z = player.z + player_dz;
  if (!IsInsideRoom(target_x, target_y, width, height)) {
    return store_and_finish(kMotionComplete, records_initial_tick);
  }

  int32_t target_index =
      FindVoxelAt(voxels, target_x, target_y, target_z, width, height);
  if (target_index < 0 && player_dz < 0) {
    // A one-step slope descent sweeps the vertical face between the source
    // and lower destination. A raised side lift mounted at the source
    // elevation blocks (or, for a deliberate input, is pushed by) that
    // diagonal move even though the endpoint cell beneath it is empty.
    const int32_t swept = FindVoxelAt(
        voxels, target_x, target_y, player.z, width, height);
    if (swept >= 0 && voxels[swept].role == kPlayerLiftRole &&
        PlayerLiftIsRaised(voxels[swept]) &&
        PlayerLiftSideOutwardDirection(voxels[swept]) >= 0) {
      target_index = swept;
    }
  }
  bool downhill_underfoot_push = false;
  bool diagonal_slope_contact = false;
  if (target_index < 0 && !automatic_player_motion &&
      player.z != INT32_MIN) {
    const int32_t current_slope = SlopeSupportingVoxel(
        voxels, player, width, height);
    if (current_slope >= 0 && state->direction == OppositeDirection(
            IceSlopeDirection(voxels[current_slope].role))) {
      const int32_t lower_target = FindVoxelAt(
          voxels,
          target_x,
          target_y,
          player.z - 1,
          width,
          height);
      const int32_t lower_object = lower_target >= 0
          ? g_voxel_object[lower_target]
          : -1;
      if (lower_object >= 0 &&
          g_object_kind[lower_object] == kWeightlessObject) {
        target_index = lower_target;
        target_z = player.z - 1;
        downhill_underfoot_push = true;
      }
    }
  }
  if (target_index < 0 && !automatic_player_motion) {
    Voxel target_cell = player;
    target_cell.x = target_x;
    target_cell.y = target_y;
    target_cell.z = target_z;
    const int32_t uphill_object = UphillSlopeContactObject(
        voxels, target_cell, state->direction, width, height);
    if (uphill_object >= 0) {
      target_index = g_object_head[uphill_object];
      diagonal_slope_contact = true;
    }
  }
  if (target_index < 0 && player_dz < 0 && target_z != INT32_MAX) {
    // A downhill step sweeps the vertical half-cell above its lower endpoint.
    // A weightless body there receives the horizontal contact even though the
    // player's final cube is one row lower. Level walking has no such sweep:
    // it may enter an empty cavity beneath an independently supported body.
    const int32_t overhead = FindVoxelAt(
        voxels, target_x, target_y, target_z + 1, width, height);
    if (overhead >= 0 && g_voxel_object[overhead] >= 0 &&
        g_object_kind[g_voxel_object[overhead]] == kWeightlessObject) {
      target_index = overhead;
    }
  }
  if (automatic_ice_motion && player_dz == -1 && target_index >= 0 &&
      voxels[target_index].role != kPlayerLiftRole &&
      g_voxel_object[target_index] >= 0 &&
      !ObjectIsFloatingFloor(voxels, g_voxel_object[target_index]) &&
      !ObjectIsFullyOnIce(
          voxels, g_voxel_object[target_index], width, height)) {
    // Automatic downhill momentum stops before a lower body. A later
    // deliberate command may step onto that body as level support, but the
    // current slide must not reinterpret it as a downhill push. Floating
    // Floors accept the push directly, subject to their destination support.
    return store_and_finish(kMotionComplete, records_initial_tick);
  }
  bool pushed = false;
  bool object_keeps_sliding = false;
  bool rode_pushed_object = false;
  bool autonomous_slope_objects_handled = false;
  bool player_lift_pending = false;
  int32_t raised_side_lift_contact = -1;
  bool raised_side_lift_inward_contact = false;
  bool lowered_side_lift_for_entry = false;
  RiderSnapshot rider;
  if (target_index >= 0 &&
      voxels[target_index].role == kPlayerLiftRole &&
      PlayerLiftIsRaised(voxels[target_index])) {
    const int32_t outward = PlayerLiftSideOutwardDirection(
        voxels[target_index]);
    if (outward >= 0) {
      raised_side_lift_contact = target_index;
      raised_side_lift_inward_contact =
          state->direction == OppositeDirection(outward);
      const int32_t lift_object = g_voxel_object[target_index];
      const int32_t attachment = PlayerLiftSideAttachmentVoxel(
          voxels, lift_object, width, height);
      const int32_t support_object = attachment >= 0
          ? g_voxel_object[attachment]
          : -1;
      const bool movable_support = support_object >= 0 &&
          (g_object_kind[support_object] == kNormalObject ||
           g_object_kind[support_object] == kWeightlessObject);
      if (automatic_ice_motion &&
          (!movable_support || !ObjectIsFullyOnIce(
              voxels, support_object, width, height))) {
        // Ice momentum can transmit through a mounted actuator only while
        // the complete supporting body is itself slippery. Floor-anchored
        // mechanisms stop automatic motion; a fresh command may still push.
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
      if (!movable_support) {
        if (!raised_side_lift_inward_contact) {
          return store_and_finish(kMotionComplete, records_initial_tick);
        }
        --voxels[target_index].generic_id;
        lowered_side_lift_for_entry = true;
        target_index = -1;
      }
    }
  }
  if (target_index >= 0) {
    int32_t object = g_voxel_object[target_index];
    if (object >= 0 && g_object_kind[object] == kCloneObject) {
      // Clones are actors, not pushable cargo. The player's independent
      // proposal stops on a clone that did not vacate this cell.
      return store_and_finish(kMotionComplete, records_initial_tick);
    }
    if (object >= 0 && g_object_kind[object] == kMechanismObject) {
      const int32_t mechanism_support = raised_side_lift_contact >= 0
          ? PlayerLiftSideAttachmentVoxel(
                voxels, object, width, height)
          : target_z == INT32_MIN ? -1 : FindVoxelAt(
                voxels, target_x, target_y, target_z - 1, width, height);
      const int32_t support_object = mechanism_support >= 0
          ? g_voxel_object[mechanism_support]
          : -1;
      if (support_object < 0 ||
          (g_object_kind[support_object] != kNormalObject &&
           g_object_kind[support_object] != kWeightlessObject)) {
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
      target_index = mechanism_support;
      object = support_object;
    }
    const bool descending_slope_impact = automatic_ice_motion &&
        player_dz != 0 && ObjectAcceptsSlopeContactPush(voxels, object);
    const int32_t crest_support = automatic_ice_motion && player_dz == 0
        ? SlopeSupportingVoxel(voxels, player, width, height) : -1;
    const bool crest_slope_impact = crest_support >= 0 &&
        ObjectAcceptsSlopeContactPush(voxels, object) &&
        IceSlopeDirection(voxels[crest_support].role) == state->direction;
    if ((automatic_ice_motion && !descending_slope_impact &&
         !crest_slope_impact) || object < 0) {
      return store_and_finish(kMotionComplete, records_initial_tick);
    }
    if (automatic_punch_motion && !player_punch_activated_this_tick) {
      const uint8_t target_momentum = ReadObjectMomentum(
          state->horizontal_momentum, object);
      if (!IsPunchMomentum(target_momentum) ||
          ((target_momentum - 1) & 3) != state->direction) {
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
    }
    const int32_t target_support = target_z == INT32_MIN ? -1 : FindVoxelAt(
        voxels, target_x, target_y, target_z - 1, width, height);
    const bool target_support_stays = target_support >= 0 &&
        g_voxel_object[target_support] != object;
    int32_t required_player_carrier = -1;
    if (!target_support_stays) {
      const int32_t current_support = player.z == INT32_MIN ? -1 : FindVoxelAt(
          voxels, player.x, player.y, player.z - 1, width, height);
      const bool may_leave_support = started_on_ice ||
          (current_support >= 0 &&
           (voxels[current_support].role == kFloorRole ||
            g_voxel_object[current_support] == object));
      if (!may_leave_support) {
        // A wrapping push chain can move the separate body under the player.
        // Defer that case until collision closure proves the support moves;
        // stationary terrain still obeys the normal ledge restriction.
        required_player_carrier = current_support >= 0
            ? g_voxel_object[current_support] : -1;
        if (required_player_carrier < 0) {
          return store_and_finish(kMotionComplete, records_initial_tick);
        }
      }
    }
    rider = CapturePlayerRider(voxels, player_index, width, height);
    ClearMovingObjects();
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>(state->direction);
    if (raised_side_lift_contact >= 0 && !automatic_ice_motion) {
      const int32_t low_z = target_z < player_from_z
          ? target_z
          : player_from_z;
      const int32_t high_z = target_z > player_from_z
          ? target_z
          : player_from_z;
      for (int32_t index = 0; index < count; ++index) {
        if (index == raised_side_lift_contact ||
            voxels[index].role != kPlayerLiftRole ||
            !PlayerLiftIsRaised(voxels[index]) ||
            voxels[index].x != target_x || voxels[index].y != target_y ||
            voxels[index].z < low_z || voxels[index].z > high_z) {
          continue;
        }
        const int32_t lift_object = g_voxel_object[index];
        const int32_t attachment = PlayerLiftSideAttachmentVoxel(
            voxels, lift_object, width, height);
        const int32_t contacted_object = attachment >= 0
            ? g_voxel_object[attachment]
            : -1;
        if (contacted_object < 0 ||
            (g_object_kind[contacted_object] != kNormalObject &&
             g_object_kind[contacted_object] != kWeightlessObject)) {
          continue;
        }
        g_mandatory_objects[contacted_object] = 1;
        g_moving_objects[contacted_object] = 1;
        g_object_direction[contacted_object] =
            static_cast<uint8_t>(state->direction);
      }
    }
    AddDeliberateUphillSlopeContactClosure(
        voxels, width, height);
    AddAutonomousSlopeObjects(
        voxels, player_index, state->direction, width, height, true);
    g_ignored_support_voxel = player_index;
    bool player_was_pushed = false;
    const bool slope_scene = SceneHasIceSlopes(
        voxels, count, width, height);
    bool diagonal_downhill_blocked = false;
    bool diagonal_has_stationary_object_support = false;
    if (slope_scene && diagonal_slope_contact) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].z == INT32_MIN) continue;
        const int32_t support = FindVoxelAt(
            voxels,
            voxels[member].x,
            voxels[member].y,
            voxels[member].z - 1,
            width,
            height);
        const int32_t support_object = support >= 0
            ? g_voxel_object[support]
            : -1;
        if (support_object >= 0 && support_object != object &&
            g_mandatory_objects[support_object] == 0) {
          diagonal_has_stationary_object_support = true;
          break;
        }
      }
      const int32_t downhill = ObjectDownhillSlopeDirection(
          voxels, object, width, height);
      if (downhill >= 0) {
        g_object_direction[object] = static_cast<uint8_t>(downhill);
        diagonal_downhill_blocked = !DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height);
        g_object_direction[object] = static_cast<uint8_t>(state->direction);
      }
    }
    const bool object_translated = !diagonal_downhill_blocked &&
        !diagonal_has_stationary_object_support && (slope_scene
        ? TranslateSlopeMomentumObjects(
              voxels,
              count,
              player_index,
              width,
              height,
              true,
              diagonal_slope_contact,
              false,
              true,
              player_was_pushed,
              required_player_carrier)
        : TranslateMovingObjects(
              voxels,
              count,
              player_index,
              dx,
              dy,
              0,
              width,
              height,
              true,
              true,
              true,
              true,
              true,
              required_player_carrier));
    if (!object_translated) {
      g_ignored_support_voxel = -1;
      if (required_player_carrier >= 0) {
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
      if (raised_side_lift_inward_contact &&
          raised_side_lift_contact >= 0) {
        ClearMovingObjects();
        --voxels[raised_side_lift_contact].generic_id;
        lowered_side_lift_for_entry = true;
        target_index = -1;
      } else if (diagonal_slope_contact) {
        ClearMovingObjects();
        const int32_t downhill = ObjectDownhillSlopeDirection(
            voxels, object, width, height);
        if (downhill >= 0 && !diagonal_has_stationary_object_support) {
          g_mandatory_objects[object] = 1;
          g_moving_objects[object] = 1;
          g_object_direction[object] = static_cast<uint8_t>(downhill);
          if (DeferredSlopeProposalIsClear(
                  voxels, object, player_index, width, height)) {
            StoreMandatoryMomentum(
                state, voxels, count, width, height, downhill);
            object_keeps_sliding = true;
            autonomous_slope_objects_handled = true;
          } else {
            g_mandatory_objects[object] = 0;
            g_moving_objects[object] = 0;
          }
        }
        target_index = -1;
      } else if (downhill_underfoot_push) {
        // A blocked downhill body remains a stable walking surface. The
        // player steps onto its top without moving the rigid body.
        target_index = -1;
        target_z = player_from_z;
      } else {
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
    } else {
      g_ignored_support_voxel = -1;
      pushed = true;
      if (downhill_underfoot_push) {
        for (int32_t moving = 0; moving < g_object_count; ++moving) {
          if (g_mandatory_objects[moving] != 0 &&
              ObjectIsFullyOnFlatIce(
                  voxels, moving, width, height)) {
            object_keeps_sliding = true;
          } else {
            g_mandatory_objects[moving] = 0;
            g_moving_objects[moving] = 0;
          }
        }
        if (object_keeps_sliding) {
          StoreMandatoryMomentum(
              state, voxels, count, width, height, state->direction);
        }
      } else {
        bool has_deferred = false;
        for (int32_t moving = 0; moving < g_object_count; ++moving) {
          has_deferred |= g_deferred_slope_objects[moving] != 0;
        }
        if (has_deferred) {
          for (int32_t moving = 0; moving < g_object_count; ++moving) {
            if (g_mandatory_objects[moving] != 0 &&
                g_deferred_slope_objects[moving] == 0 &&
                !ObjectIsFullyOnIce(voxels, moving, width, height)) {
              g_mandatory_objects[moving] = 0;
              g_moving_objects[moving] = 0;
            }
          }
        }
        const bool deferred = has_deferred && PromoteDeferredSlopeMomentum(
            voxels, player_index, width, height);
        (void)deferred;
        if (automatic_punch_motion) {
          // Every rigid body advanced by the punch contact belongs to the
          // same convoy. Give the complete train the persistent impulse so
          // it keeps its spacing on subsequent ticks.
          SeedMovingObjectsWithPunchMomentum(state, state->direction);
        }
        object_keeps_sliding = StoreSupportedMandatoryMomentum(
            state, voxels, count, width, height, state->direction);
      }
      if (downhill_underfoot_push && object_keeps_sliding) {
        state->reserved[1] = 1;
      }
      rode_pushed_object =
          MovePlayerWithRider(voxels, player_index, rider, width, height);
    }
  } else if (target_z != INT32_MIN) {
    const int32_t direct_support = FindVoxelAt(
        voxels, target_x, target_y, target_z - 1, width, height);
    if (direct_support >= 0 &&
        voxels[direct_support].role == kFloatingFloorRole) {
      return store_and_finish(kMotionComplete, records_initial_tick);
    }
    if (direct_support < 0) {
      const int32_t lower_support = FindNearestVoxelBelow(
          voxels, count, target_x, target_y, target_z, -1, width);
      const int32_t current_support = FindVoxelAt(
          voxels, player.x, player.y, player.z - 1, width, height);
      const bool may_leave_support = automatic_player_motion ||
          started_on_ice ||
          (current_support >= 0 && voxels[current_support].role == kFloorRole &&
           lower_support < 0);
      if (!may_leave_support) {
        return store_and_finish(kMotionComplete, records_initial_tick);
      }
    }
  }

  if (!pushed && !autonomous_slope_objects_handled &&
      SceneHasIceSlopes(voxels, count, width, height)) {
    ClearMovingObjects();
    if (AddAutonomousSlopeObjects(
            voxels,
            player_index,
            state->direction,
            width,
            height)) {
      autonomous_slope_objects_handled = true;
      const bool defer_until_player_vacates =
          SlopeObjectProposalEntersPlayerFromDifferentDirection(
              voxels, player_index, dx, dy, width, height);
      bool player_was_pushed = false;
      const bool translated = !defer_until_player_vacates &&
          TranslateSlopeMomentumObjects(
              voxels,
              count,
              player_index,
              width,
              height,
              false,
              false,
              false,
              true,
              player_was_pushed);
      if (translated) {
        const bool deferred = PromoteDeferredSlopeMomentum(
            voxels, player_index, width, height);
        (void)deferred;
        if (automatic_punch_motion) {
          SeedMovingObjectsWithPunchMomentum(state, state->direction);
        }
        object_keeps_sliding = StoreSupportedMandatoryMomentum(
            state, voxels, count, width, height, state->direction);
      } else {
        const bool deferred = PromoteDeferredSlopeMomentum(
            voxels, player_index, width, height);
        if (deferred || defer_until_player_vacates) {
          StoreMandatoryMomentum(
              state, voxels, count, width, height, state->direction);
          object_keeps_sliding = deferred ||
              MovingObjectsAreFullyOnIce(voxels, width, height);
        }
      }
    }
  }

  if (!pushed) {
    if (!autonomous_slope_objects_handled) {
      ClearMovingObjects();
    }
    if (!autonomous_slope_objects_handled && !TranslateMovingObjects(
            voxels,
            count,
            player_index,
            dx,
            dy,
            0,
            width,
            height,
            true,
            true,
            true)) {
      return store_and_finish(kMotionComplete, records_initial_tick);
    }
  }

  if (!rode_pushed_object) {
    player.x = target_x;
    player.y = target_y;
    player.z = target_z;
    (void)RaiseVacatedUpwardPlayerLift(
        voxels,
        count,
        player_index,
        player_from_x,
        player_from_y,
        player_from_z,
        false);
    player_lift_pending = !lowered_side_lift_for_entry &&
        PlayerLiftCanToggleOnEntry(
            voxels,
            count,
            player_index,
            player_from_x,
            player_from_y,
            width,
            height);
  } else {
    // A rider follows its carrier, not the target cell that was computed
    // before the carrier's translation.
    (void)player_from_x;
    (void)player_from_y;
    (void)player_from_z;
  }
  BuildSpatialIndex(voxels, count, width, height);
  if (pushed) g_ignored_support_voxel = player_index;
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  g_ignored_support_voxel = -1;

  if (vacated_lift_retry_pending) {
    ClearHorizontalMomentum(state, count);
    state->reserved[0] = kResumeVacatedLift;
    return store_and_finish(kMotionPlayerLift, true, true);
  }

  if (player_lift_pending) {
    ClearHorizontalMomentum(state, count);
    return store_and_finish(kMotionPlayerLift, true, true);
  }

  if (automatic_punch_motion) {
    // Punch motion postpones gravity rather than disarming it. Keeping the
    // body armed makes the contact frame canonical for cycle detection and
    // lets a blocked airborne trajectory begin falling immediately.
    state->player_gravity_armed = 1;
    const int32_t next_punch_phase = player_dz > 0
        ? kMotionPlayerPunchUp
        : player_dz < 0
            ? kMotionPlayerPunchDown
            : kMotionPlayerPunch;
    return store_and_finish(next_punch_phase, true, true);
  }

  if (object_keeps_sliding) {
    return store_and_finish(kMotionObjectIce, true);
  }

  const bool player_gravity_pending =
      defer_player_gravity(automatic_ice_motion, started_on_ice, pushed);
  if (player_gravity_pending) {
    const bool gravity_continues =
        state->player_falling != 0 ||
        ObjectsNeedGravityTick(voxels, count, width, height, false);
    state->reserved[0] =
        ((automatic_ice_motion &&
        VoxelWillLandOnSlope(voxels, count, player, -1, width)) ||
        (pushed && IsSupportedByIce(voxels, player, width, height)))
        ? kResumePlayerIce
        : kResumeNothing;
    return store_and_finish(
        gravity_continues ? kMotionGravity : kMotionComplete,
        true,
        true);
  }

  if (!downhill_underfoot_push &&
      IsSupportedByIce(voxels, player, width, height)) {
    // A displaced Floating Floor which did not retain momentum is stationary
    // on the following player phase. Clear only that stale proposal so slope
    // redirection sees it as the obstruction it is; other established convoy
    // proposals retain their synchronized timing.
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (ObjectIsFloatingFloor(voxels, object) &&
          ReadObjectMomentum(state->horizontal_momentum, object) == 0) {
        g_mandatory_objects[object] = 0;
        g_moving_objects[object] = 0;
      }
    }
    return store_and_finish(kMotionPlayerIce, true);
  }
  const bool gravity_continues =
      ObjectsNeedGravityTick(voxels, count, width, height, false);
  if (gravity_continues && pushed &&
      MovingObjectWillLandOnSlope(voxels, count, width)) {
    StoreMandatoryMomentum(
        state, voxels, count, width, height, state->direction);
    state->reserved[0] = kResumeObjectIce;
  } else {
    state->reserved[0] = gravity_continues &&
        IsSupportedByIce(voxels, player, width, height)
        ? kResumePlayerIce
        : kResumeNothing;
  }
  return store_and_finish(
      gravity_continues ? kMotionGravity : kMotionComplete,
      true,
      true);
}
