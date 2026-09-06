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
