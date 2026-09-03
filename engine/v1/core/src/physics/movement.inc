bool AddMandatoryObject(int32_t object, int32_t& queue_end) {
  if (object < 0 || g_mandatory_objects[object] != 0) return false;
  g_mandatory_objects[object] = 1;
  g_moving_objects[object] = 1;
  g_carried_objects[object] = 0;
  g_object_queue[queue_end++] = object;
  return true;
}

void ClearMovingObjects() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = 0;
    g_mandatory_objects[object] = 0;
    g_carried_objects[object] = 0;
    g_rejected_carriers[object] = 0;
    g_fell_objects[object] = 0;
    g_carrier_parent[object] = -1;
    g_object_direction[object] = 0xff;
  }
}

bool ObjectCanTransmitDeliberatePush(int32_t object) {
  if (object < 0) return false;
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

bool DeliberatePushMayRecruit(int32_t source, int32_t target) {
  if (!ObjectCanTransmitDeliberatePush(source) || target < 0) return false;
  if (g_object_kind[target] == kWeightlessObject) return true;
  if (g_object_kind[target] != kNormalObject) return false;
  // The command supplies one unit of push force. Weightless polycubes can
  // occur anywhere in the contact closure, but only one ordinary box or
  // Floating Floor may participate in the complete transaction.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 &&
        g_object_kind[object] == kNormalObject) {
      return false;
    }
  }
  return true;
}

bool FloatingFloorDestinationIsSupportedOrFillable(
    Voxel* voxels,
    int32_t object,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height) {
  if (!ObjectIsFloatingFloor(voxels, object)) return true;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    const int32_t target_z = voxel.z + dz;
    const int32_t support = target_z == INT32_MIN ? -1 : FindVoxelAt(
        voxels,
        voxel.x + dx,
        voxel.y + dy,
        target_z - 1,
        width,
        height);
    // Row 1 is the one deliberate unsupported exception: entering a Row-0
    // hole schedules the authored visible-hover frame followed by Floor fill.
    if (support < 0 && target_z != 1) return false;
  }
  return true;
}

void ArmTranslatedFloatingFloors(Voxel* voxels) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] != 0 &&
        ObjectIsFloatingFloor(voxels, object)) {
      g_object_gravity_armed[object] = 1;
    }
  }
}

// A compressed Orange Wall voxel is non-colliding, but its raised anchor can
// be embedded in a movable polycube (or immediately beneath that polycube's
// bottom voxel). In that authored arrangement it is a fixture of the rigid
// body and translates with the body's deliberate proposal. The wall keeps its
// depth; only its stable raised anchor moves in X/Y/Z.
void TranslateHiddenOrangeWallsWithProposals(
    Voxel* voxels,
    int32_t count,
    bool uniform,
    int32_t uniform_dx,
    int32_t uniform_dy,
    int32_t uniform_dz,
    bool include_carried) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms ||
      (uniform && uniform_dx == 0 && uniform_dy == 0)) {
    return;
  }
  for (int32_t wall_index = 0; wall_index < count; ++wall_index) {
    Voxel& wall = voxels[wall_index];
    if (wall.role != kOrangeWallRole ||
        !OrangeWallIsHiddenForDepth(
            voxels, count, wall_index, OrangeWallDepth(wall))) {
      continue;
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if ((g_mandatory_objects[object] == 0 &&
           (!include_carried || g_carried_objects[object] == 0 ||
            g_carrier_parent[object] != -2)) ||
          g_rejected_carriers[object] != 0 ||
          g_object_kind[object] == kMechanismObject) {
        continue;
      }
      bool attached = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        attached = voxels[member].x == wall.x &&
            voxels[member].y == wall.y &&
            (voxels[member].z == wall.z ||
             (wall.z != INT32_MAX && voxels[member].z == wall.z + 1));
        if (attached) break;
      }
      if (!attached) continue;
      wall.x += uniform ? uniform_dx : g_object_dx[object];
      wall.y += uniform ? uniform_dy : g_object_dy[object];
      wall.z += uniform ? uniform_dz : g_object_dz[object];
      break;
    }
  }
}

bool OrangeButtonSharesCellWith(
    Voxel* voxels,
    const Voxel& voxel) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
    if (voxels[index].role == kOrangeButtonRole &&
        voxels[index].x == voxel.x && voxels[index].y == voxel.y &&
        voxels[index].z == voxel.z) {
      return true;
    }
  }
  return false;
}

int32_t MovingSupportBelowObject(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    bool carry_from_player,
    int32_t width,
    int32_t height) {
  // A mounted fixture participates in the carrier footprint of its complete
  // rigid assembly. If that fixture is resting on a moving body, the mount
  // transmits the carry even when another part of the assembly also has a
  // stationary foothold.
  for (int32_t lift_object = 0; lift_object < g_object_count; ++lift_object) {
    const int32_t fixture = g_object_head[lift_object];
    if (fixture >= 0 && voxels[fixture].role == kOrangeButtonRole) {
      continue;
    }
    if (!PlayerLiftIsAttachedToObject(
            voxels, lift_object, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[lift_object]; member >= 0;
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
          support_object != lift_object &&
          g_moving_objects[support_object] != 0) {
        return support_object;
      }
    }
  }
  const int32_t fixture = g_object_head[object];
  const int32_t attachment = fixture >= 0 &&
          voxels[fixture].role == kPuncherRole
      ? MechanismAttachmentVoxel(voxels, object, width, height)
      : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
  if (attachment >= 0) {
    const int32_t support_object = g_voxel_object[attachment];
    if (support_object >= 0 && support_object != object &&
        g_moving_objects[support_object] != 0) {
      return support_object;
    }
    return -1;
  }
  int32_t moving_support = -1;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support < 0) continue;
    if (g_voxel_object[support] == object) continue;
    if (carry_from_player && support == player_index) {
      moving_support = -2;
      continue;
    }
    const int32_t support_object = g_voxel_object[support];
    if (support_object >= 0 && support_object != object &&
        g_moving_objects[support_object] != 0) {
      if (moving_support == -1) moving_support = support_object;
      continue;
    }
    if (carry_from_player && support_object >= 0 &&
        support_object != object) {
      int32_t support_size = 0;
      for (int32_t support_member = g_object_head[support_object];
           support_member >= 0;
           support_member = g_next_object_voxel[support_member]) {
        ++support_size;
      }
      bool support_is_terrain_anchored = false;
      for (int32_t support_member = g_object_head[support_object];
           support_member >= 0;
           support_member = g_next_object_voxel[support_member]) {
        const Voxel& supported = voxels[support_member];
        if (supported.z == INT32_MIN) continue;
        const int32_t anchor = FindVoxelAt(
            voxels,
            supported.x,
            supported.y,
            supported.z - 1,
            width,
            height);
        if (anchor >= 0 && g_voxel_object[anchor] < 0 &&
            !IsIceRole(voxels[anchor].role)) {
          support_is_terrain_anchored = true;
          break;
        }
      }
      if (support_size == 1 && support_is_terrain_anchored) {
        // The player's top contact carries a body only when the player is its
        // effective carrier. A separate grounded cube is a stable pedestal,
        // so it keeps a bridged polycube in place when the player walks out
        // beneath it. Interlocking polycubes still use the carrier/collision
        // closure below rather than being reduced to a single point support.
        return -1;
      }
    }
    // Ordinary terrain provides an immovable foothold, so one moving contact
    // cannot carry the body. Ice has no such anchoring friction, and contact
    // with a different movable object is resolved by the support graph.
    if (support_object < 0 && !IsIceRole(voxels[support].role)) {
      // A pressed surface button is a yielding contact, not an anchoring
      // foothold. If another part of this body rests on the moving player,
      // the player carries the complete rigid group off those buttons.
      if (carry_from_player && OrangeButtonSharesCellWith(voxels, voxel)) {
        continue;
      }
      return -1;
    }
  }
  return moving_support;
}

void BuildCarriedObjects(
    Voxel* voxels,
    int32_t player_index,
    bool carry_from_player,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = g_mandatory_objects[object];
    g_carried_objects[object] = 0;
  }
  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] != 0 || g_rejected_carriers[object] != 0 ||
          (carry_from_player &&
           ActiveWorkspace().clone_command_tick_active &&
           (g_object_kind[object] == kCloneObject ||
            g_object_kind[object] == kPlayerObject) &&
           g_clone_command_moved[object] != 0) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      const int32_t carrier = MovingSupportBelowObject(
          voxels, object, player_index, carry_from_player, width, height);
      if (carrier != -1) {
        g_moving_objects[object] = 1;
        g_carried_objects[object] = 1;
        g_carrier_parent[object] = carrier;
        changed = true;
      }
    }
  }
}

bool ResolveCarriedCollisions(
    Voxel* voxels,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool allow_push,
    bool& added_mandatory) {
  bool changed = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_carried_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      const int32_t next_x = voxel.x + dx;
      const int32_t next_y = voxel.y + dy;
      if (!IsInsideRoom(next_x, next_y, width, height)) {
        g_rejected_carriers[object] = 1;
        changed = true;
        break;
      }
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, voxel.z + dz, width, height);
      if (occupant < 0 || occupant == player_index ||
          g_voxel_object[occupant] == object) {
        continue;
      }
      if (voxel.role == kOrangeButtonRole || voxel.role == kPuncherRole) {
        // Orange Buttons are face sensors, not rigid voxels. A mounted button
        // may ride its carrier into a cell occupied by the floor, a wall, or
        // another body while remaining independently pressable by overlap.
        continue;
      }
      if (g_object_kind[object] == kMechanismObject &&
          IsLoweredPlayerLift(voxel)) {
        // The lowered lift is a non-colliding slab. Its carrier may move it
        // through an occupied full cell; the raised cube below follows the
        // normal rigid carried-body collision rule.
        continue;
      }
      const int32_t other = g_voxel_object[occupant];
      if (other >= 0 && g_moving_objects[other] != 0) continue;
      if (other >= 0 && g_object_falling[other] != 0) {
        // A falling occupant vacates this source cell in the synchronized
        // vertical part of the tick.
        continue;
      }
      if (allow_push && g_object_kind[object] == kWeightlessObject &&
          other >= 0 && g_object_kind[other] == kWeightlessObject &&
          ObjectIsFullyOnIce(voxels, other, width, height)) {
        g_mandatory_objects[other] = 1;
        g_moving_objects[other] = 1;
        g_carried_objects[other] = 0;
        added_mandatory = true;
        changed = true;
        continue;
      }
      g_rejected_carriers[object] = 1;
      changed = true;
      break;
    }
  }
  return changed;
}

bool ObjectHasCarrierBelow(
    Voxel* voxels,
    int32_t object,
    int32_t carrier,
    int32_t width,
    int32_t height) {
  if (carrier < 0) return false;
  const int32_t attachment = MechanismAttachmentVoxel(
      voxels, object, width, height);
  if (attachment >= 0 && g_voxel_object[attachment] == carrier) {
    return true;
  }
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    for (int32_t support = g_object_head[carrier]; support >= 0;
         support = g_next_object_voxel[support]) {
      if (voxels[support].x == voxel.x && voxels[support].y == voxel.y &&
          voxels[support].z < voxel.z) {
        return true;
      }
    }
  }
  return false;
}
bool FallingObjectRefillsCell(
    Voxel* voxels,
    int32_t x,
    int32_t y,
    int32_t z,
    int32_t width,
    int32_t height) {
  if (z == INT32_MAX) return false;
  const int32_t above = FindVoxelAt(
      voxels, x, y, z + 1, width, height);
  if (above < 0) return false;
  const int32_t object = g_voxel_object[above];
  return object >= 0 && g_object_falling[object] != 0 &&
      g_moving_objects[object] == 0;
}

void TranslateObjectsCarriedByPlayerOneStep(
    Voxel* voxels,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (;;) {
    BuildCarriedObjects(
        voxels, player_index, true, width, height);
    bool added_mandatory = false;
    if (!ResolveCarriedCollisions(
            voxels,
            player_index,
            dx,
            dy,
            0,
            width,
            height,
            false,
            added_mandatory)) {
      break;
    }
  }
  TranslateHiddenOrangeWallsWithProposals(
      voxels, g_spatial_voxel_count, true, dx, dy, 0, true);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_carried_objects[object] == 0 ||
        g_rejected_carriers[object] != 0) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
    }
  }
}

void AdvanceUnmovedGravityOneStep(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    bool player_moves_horizontally,
    bool immediate_support_loss = false) {
  bool found_pending = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_pending_fall[object] = 0;
    if (g_moving_objects[object] != 0 ||
        (ActiveWorkspace().clone_command_tick_active &&
         g_clone_command_moved[object] != 0) ||
        (g_carrier_parent[object] == -2 &&
         g_rejected_carriers[object] == 0) ||
        !ObjectIsActive(voxels, object, width, height) ||
        g_object_gravity_armed[object] == 0) {
      continue;
    }
    if (immediate_support_loss && g_component_objects[object] != 0) {
      // The caller has already proven that this whole support component is
      // vacated by the horizontal half of the current tick. Every level of
      // the stack therefore owns a simultaneous downward proposal now; do
      // not make upper members spend an extra arming-only frame.
      g_object_falling[object] = 1;
      g_pending_fall[object] = 1;
      found_pending = true;
      continue;
    }
    if (ObjectHasStableDirectSupport(voxels, object, width, height)) {
      g_object_falling[object] = 0;
      continue;
    }
    if (g_object_falling[object] == 0) {
      // Support loss starts a fall. Its first one-voxel displacement is
      // proposed on the next synchronized movement tick.
      g_object_falling[object] = 1;
      continue;
    }
    g_pending_fall[object] = 1;
    found_pending = true;
  }
  if (!found_pending) return;

  // Falling bodies form simultaneous vertical proposals. A body may enter a
  // cell vacated by another falling body, but never one retained this tick.
  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_pending_fall[object] == 0) continue;
      bool blocked = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].z == INT32_MIN) {
          blocked = true;
          break;
        }
        const int32_t target_x = voxels[member].x;
        const int32_t target_y = voxels[member].y;
        const int32_t target_z = voxels[member].z - 1;
        const int32_t horizontal_source = FindVoxelAt(
            voxels,
            target_x - dx,
            target_y - dy,
            target_z,
            width,
            height);
        if ((horizontal_source >= 0 &&
             g_voxel_object[horizontal_source] >= 0 &&
             g_moving_objects[g_voxel_object[horizontal_source]] != 0) ||
            (player_moves_horizontally && player_index >= 0 &&
             voxels[player_index].x + dx == target_x &&
             voxels[player_index].y + dy == target_y &&
             voxels[player_index].z == target_z)) {
          // Horizontal motion wins a same-cell race. The descending body
          // remains above the incoming support and is caught this tick.
          blocked = true;
          break;
        }
        const int32_t occupant = FindVoxelAt(
            voxels,
            target_x,
            target_y,
            target_z,
            width,
            height);
        if (occupant < 0) continue;
        const int32_t other = g_voxel_object[occupant];
        if (other == object ||
            (other >= 0 &&
             (g_pending_fall[other] != 0 ||
              g_moving_objects[other] != 0)) ||
            (occupant == player_index && player_moves_horizontally)) {
          continue;
        }
        blocked = true;
        break;
      }
      if (blocked) {
        g_pending_fall[object] = 0;
        g_object_falling[object] = 0;
        changed = true;
      }
    }
  }

  bool moved = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_pending_fall[object] == 0) continue;
    bool has_lower_support = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (FindNearestVoxelBelow(
              voxels,
              count,
              voxels[member].x,
              voxels[member].y,
              voxels[member].z,
              object,
              width) >= 0) {
        has_lower_support = true;
        break;
      }
    }
    const bool disappears = !has_lower_support &&
        ObjectHasPassedEverythingElse(voxels, count, object, width, height);
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      --voxels[member].z;
      if (disappears) voxels[member].x = -1;
    }
    if (disappears) g_object_falling[object] = 0;
    moved = true;
  }
  if (!moved) return;
  BuildSpatialIndex(voxels, count, width, height);
  // Clear momentum for bodies that landed on support which will remain after
  // the horizontal half of this tick. Propagate from the bottom upward so a
  // newly stable body can support another descending body in the same frame.
  bool settled = true;
  while (settled) {
    settled = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_pending_fall[object] == 0) continue;
      bool has_stationary_support = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0 || g_voxel_object[support] == object) continue;
        if (support == player_index && player_moves_horizontally) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 &&
            (g_moving_objects[support_object] != 0 ||
             g_pending_fall[support_object] != 0)) {
          continue;
        }
        has_stationary_support = true;
        break;
      }
      if (has_stationary_support) {
        g_pending_fall[object] = 0;
        g_object_falling[object] = 0;
        settled = true;
      }
    }
  }
}

void MarkObjectsForDeferredGravity(
    Voxel* voxels,
    int32_t width,
    int32_t height,
    bool moving_only) {
  if (g_object_count == 1) {
    g_component_objects[0] = 0;
    if (!ObjectIsActive(voxels, 0, width, height) ||
        g_object_gravity_armed[0] == 0 ||
        (moving_only && g_moving_objects[0] == 0)) {
      return;
    }
    g_object_falling[0] =
        ObjectHasDirectSupport(voxels, 0, width, height) ? 0 : 1;
    return;
  }

  // Horizontal translation and gravity are separate ticks. First find which
  // translated bodies are connected to stationary support, including through
  // another translated body. Unsupported cycles remain ungrounded.
  auto eligible = [&](int32_t object) {
    return ObjectIsActive(voxels, object, width, height) &&
        g_object_gravity_armed[object] != 0 &&
        (!moving_only || g_moving_objects[object] != 0);
  };
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_component_objects[object] = 0;
    if (!eligible(object)) continue;
    bool attached_fixture_is_grounded = false;
    for (int32_t lift_object = 0; lift_object < g_object_count &&
         !attached_fixture_is_grounded; ++lift_object) {
      const int32_t fixture = g_object_head[lift_object];
      if (fixture >= 0 && voxels[fixture].role == kOrangeButtonRole) {
        continue;
      }
      if (!PlayerLiftIsAttachedToObject(
              voxels, lift_object, object, width, height)) {
        continue;
      }
      for (int32_t member = g_object_head[lift_object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].z == INT32_MIN) continue;
        const int32_t support = FindVoxelAt(
            voxels,
            voxels[member].x,
            voxels[member].y,
            voxels[member].z - 1,
            width,
            height);
        if (support < 0 || support == g_ignored_support_voxel) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object != object && support_object != lift_object &&
            (support_object < 0 || !eligible(support_object))) {
          attached_fixture_is_grounded = true;
          break;
        }
      }
    }
    if (attached_fixture_is_grounded) {
      g_component_objects[object] = 1;
      continue;
    }
    const int32_t attachment_member = g_object_head[object];
    const int32_t attachment = attachment_member >= 0 &&
            voxels[attachment_member].role == kPuncherRole
        ? MechanismAttachmentVoxel(voxels, object, width, height)
        : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
    if (attachment >= 0) {
      const int32_t support_object = g_voxel_object[attachment];
      if (support_object != object &&
          (support_object < 0 || !eligible(support_object))) {
        g_component_objects[object] = 1;
        continue;
      }
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      if (voxel.z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
      if (support < 0 || support == g_ignored_support_voxel) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object != object &&
          (support_object < 0 || !eligible(support_object))) {
        g_component_objects[object] = 1;
        break;
      }
    }
  }

  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!eligible(object) || g_component_objects[object] != 0) {
        continue;
      }
      bool supported_by_attached_fixture = false;
      for (int32_t lift_object = 0; lift_object < g_object_count;
           ++lift_object) {
        const int32_t fixture = g_object_head[lift_object];
        if (fixture >= 0 && voxels[fixture].role == kOrangeButtonRole) {
          continue;
        }
        if (g_component_objects[lift_object] != 0 &&
            PlayerLiftIsAttachedToObject(
                voxels, lift_object, object, width, height)) {
          supported_by_attached_fixture = true;
          break;
        }
      }
      if (supported_by_attached_fixture) {
        g_component_objects[object] = 1;
        changed = true;
        continue;
      }
      const int32_t attachment_member = g_object_head[object];
      const int32_t attachment = attachment_member >= 0 &&
              voxels[attachment_member].role == kPuncherRole
          ? MechanismAttachmentVoxel(voxels, object, width, height)
          : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
      if (attachment >= 0) {
        const int32_t support_object = g_voxel_object[attachment];
        if (support_object >= 0 && support_object != object &&
            g_component_objects[support_object] != 0) {
          g_component_objects[object] = 1;
          changed = true;
          continue;
        }
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        if (voxel.z == INT32_MIN) continue;
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0 || support == g_ignored_support_voxel) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 && support_object != object &&
            g_component_objects[support_object] != 0) {
          g_component_objects[object] = 1;
          changed = true;
          break;
        }
      }
    }
  }

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (!eligible(object)) continue;
    g_object_falling[object] = g_component_objects[object] == 0 ? 1 : 0;
  }
}

bool TranslateMovingObjects(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool carry_from_player,
    bool allow_push,
    bool player_moves_horizontally,
    bool advance_unmoved_gravity = true,
    bool commit_translation = true) {
  g_moving_objects_fell = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_fell_objects[object] = 0;
  }

  if (commit_translation && g_object_count == 1 &&
      g_mandatory_objects[0] != 0 &&
      ObjectIsActive(voxels, 0, width, height)) {
    // The overwhelmingly common Sokoban push has no carrier graph, object
    // closure, or inter-body race to resolve. Preserve the exact general-path
    // collision rules while avoiding several redundant graph passes per Ice
    // cell. Complex scenes continue through the solver below.
    if (allow_push &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels, 0, dx, dy, dz, width, height)) {
      return false;
    }
    for (int32_t member = g_object_head[0]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      const int32_t next_x = voxel.x + dx;
      const int32_t next_y = voxel.y + dy;
      if (!IsInsideRoom(next_x, next_y, width, height)) return false;
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, voxel.z + dz, width, height);
      if (g_object_kind[0] == kMechanismObject &&
          IsPassThroughVoxel(voxel) &&
          !(IsLoweredPlayerLift(voxel) && occupant >= 0 &&
            voxels[occupant].role == kFloorRole)) {
        continue;
      }
      if (occupant >= 0) {
        if (occupant == player_index) {
          if (!player_moves_horizontally) return false;
        } else if (g_voxel_object[occupant] != 0) {
          return false;
        }
      }
    }
    g_moving_objects[0] = 1;
    g_carried_objects[0] = 0;
    g_rejected_carriers[0] = 0;
    g_carrier_parent[0] = -1;
    for (int32_t member = g_object_head[0]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
      voxels[member].z += dz;
    }
    ArmTranslatedFloatingFloors(voxels);
    BuildSpatialIndex(voxels, count, width, height);
    MarkObjectsForDeferredGravity(voxels, width, height, false);
    return true;
  }

  int32_t queue_begin = 0;
  int32_t queue_end = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 &&
        ObjectIsActive(voxels, object, width, height)) {
      g_object_queue[queue_end++] = object;
    }
  }
  while (queue_begin < queue_end) {
    const int32_t object = g_object_queue[queue_begin++];
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      const int32_t next_x = voxel.x + dx;
      const int32_t next_y = voxel.y + dy;
      if (!IsInsideRoom(next_x, next_y, width, height)) return false;
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, voxel.z + dz, width, height);
      if (g_object_kind[object] == kMechanismObject &&
          IsPassThroughVoxel(voxel) &&
          !(IsLoweredPlayerLift(voxel) && occupant >= 0 &&
            voxels[occupant].role == kFloorRole)) {
        continue;
      }
      if (occupant < 0) continue;
      if (occupant == player_index) {
        if (player_moves_horizontally) continue;
        return false;
      }
      const int32_t other_object = g_voxel_object[occupant];
      if (other_object == object ||
          (other_object >= 0 && g_mandatory_objects[other_object] != 0) ||
          PlayerLiftIsAttachedToObject(
              voxels, other_object, object, width, height)) {
        continue;
      }
      if (other_object >= 0 && g_object_falling[other_object] != 0 &&
          g_moving_objects[other_object] == 0) {
        // The occupant's synchronized downward proposal vacates this cell.
        // A vertical stack can refill it in the same tick, however, in which
        // case the trailing horizontal body must stop before gravity commits.
        if (FallingObjectRefillsCell(
                voxels, next_x, next_y, voxel.z, width, height)) {
          return false;
        }
        continue;
      }
      if (allow_push &&
          DeliberatePushMayRecruit(object, other_object)) {
        AddMandatoryObject(other_object, queue_end);
        continue;
      }
      return false;
    }
  }

  for (;;) {
    BuildCarriedObjects(
        voxels, player_index, carry_from_player, width, height);
    bool added_mandatory = false;
    const bool changed = ResolveCarriedCollisions(
        voxels,
        player_index,
        dx,
        dy,
        dz,
        width,
        height,
        allow_push,
        added_mandatory);
    if (!changed) break;
    if (added_mandatory) {
      // Newly pushed passengers must receive the same collision closure as
      // the original deliberate push before the substep can commit.
      queue_begin = 0;
      queue_end = 0;
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (g_mandatory_objects[object] != 0 &&
            ObjectIsActive(voxels, object, width, height)) {
          g_object_queue[queue_end++] = object;
        }
      }
      while (queue_begin < queue_end) {
        const int32_t object = g_object_queue[queue_begin++];
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          const Voxel& voxel = voxels[member];
          const int32_t next_x = voxel.x + dx;
          const int32_t next_y = voxel.y + dy;
          if (!IsInsideRoom(next_x, next_y, width, height)) return false;
          const int32_t occupant = FindVoxelAt(
              voxels, next_x, next_y, voxel.z + dz, width, height);
          if (g_object_kind[object] == kMechanismObject &&
              IsPassThroughVoxel(voxel) &&
              !(IsLoweredPlayerLift(voxel) && occupant >= 0 &&
                voxels[occupant].role == kFloorRole)) {
            continue;
          }
          if (occupant < 0 || occupant == player_index) continue;
          const int32_t other = g_voxel_object[occupant];
          if (other == object ||
              (other >= 0 && g_mandatory_objects[other] != 0)) {
            continue;
          }
          if (allow_push && DeliberatePushMayRecruit(object, other)) {
            AddMandatoryObject(other, queue_end);
            continue;
          }
          return false;
        }
      }
    }
  }

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] == kMechanismObject &&
        g_carrier_parent[object] >= 0 &&
        g_rejected_carriers[object] != 0) {
      // A raised fixture caught against terrain anchors the carrier beneath
      // it. Nothing has translated yet, so the complete proposal can abort
      // transactionally.
      return false;
    }
    if (allow_push && g_mandatory_objects[object] != 0 &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels, object, dx, dy, dz, width, height)) {
      return false;
    }
  }

  bool found_moving = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    found_moving |= g_moving_objects[object] != 0;
  }
  if (!commit_translation) return true;
  if (!found_moving) {
    if (advance_unmoved_gravity) {
      AdvanceUnmovedGravityOneStep(
          voxels,
          count,
          width,
          height,
          player_index,
          dx,
          dy,
          player_moves_horizontally);
    }
    return true;
  }

  // Commit already-armed vertical proposals before horizontal translation.
  // Collision validation above treats those source cells as vacating, while
  // the gravity resolver cancels any destination contested by a horizontal
  // proposal. Both axes therefore advance once in the same animation tick.
  if (advance_unmoved_gravity) {
    AdvanceUnmovedGravityOneStep(
        voxels,
        count,
        width,
        height,
        player_index,
        dx,
        dy,
        player_moves_horizontally);
  }

  TranslateHiddenOrangeWallsWithProposals(
      voxels, count, true, dx, dy, dz, carry_from_player);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
      voxels[member].z += dz;
    }
  }
  ArmTranslatedFloatingFloors(voxels);
  BuildSpatialIndex(voxels, count, width, height);
  // A stationary body can lose support when a different body translates out
  // from beneath it. Mark every armed body here so that its downward proposal
  // participates in the next synchronized tick, just like a translated body
  // which leaves the edge of its own support.
  MarkObjectsForDeferredGravity(voxels, width, height, false);

  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_carried_objects[object] == 0 || g_rejected_carriers[object] != 0) {
        continue;
      }
      const int32_t carrier = g_carrier_parent[object];
      if (carrier >= 0 && g_fell_objects[carrier] == 0 &&
          g_rejected_carriers[carrier] == 0) {
        continue;
      }
      if (carrier == -2) continue;
      if (!ObjectHasCarrierBelow(
              voxels, object, carrier, width, height)) {
        g_rejected_carriers[object] = 1;
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          voxels[member].x -= dx;
          voxels[member].y -= dy;
          voxels[member].z -= dz;
        }
      }
      g_carried_objects[object] = 0;
      g_moving_objects[object] = g_mandatory_objects[object];
      BuildSpatialIndex(voxels, count, width, height);
      changed = true;
    }
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_fell_objects[object] != 0) g_mandatory_objects[object] = 0;
  }
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  return true;
}

bool MovingObjectsAreFullyOnIce(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  bool found_active = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    found_active = true;
    if (!ObjectIsFullyOnIce(voxels, object, width, height)) return false;
  }
  return found_active;
}

bool IsSupportedByIce(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t width,
    int32_t height) {
  if (voxel.z == INT32_MIN) return false;
  const int32_t support = FindVoxelAt(
      voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
  return support >= 0 && IsIceRole(voxels[support].role);
}

int32_t SlopeSupportingVoxel(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t width,
    int32_t height) {
  if (voxel.z == INT32_MIN) return -1;
  const int32_t support = FindVoxelAt(
      voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
  return support >= 0 && IsIceSlopeRole(voxels[support].role)
      ? support
      : -1;
}

int32_t RedirectSlopeDirection(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t direction,
    int32_t width,
    int32_t height) {
  const int32_t support = SlopeSupportingVoxel(
      voxels, voxel, width, height);
  if (support < 0) return direction;
  const int32_t slope_direction = IceSlopeDirection(voxels[support].role);
  if (direction != slope_direction &&
      direction != OppositeDirection(slope_direction)) {
    return OppositeDirection(slope_direction);
  }
  if (direction != slope_direction) return direction;

  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t next_x = voxel.x + kDx[direction];
  const int32_t next_y = voxel.y + kDy[direction];
  if (!IsInsideRoom(next_x, next_y, width, height)) {
    return OppositeDirection(direction);
  }
  const int32_t ascending_slope = FindVoxelAt(
      voxels, next_x, next_y, voxel.z, width, height);
  if (ascending_slope >= 0 &&
      IceSlopeDirection(voxels[ascending_slope].role) == direction) {
    return direction;
  }
  const int32_t same_height_occupant = FindVoxelAt(
      voxels, next_x, next_y, voxel.z, width, height);
  if (same_height_occupant >= 0) {
    const int32_t occupant_object = g_voxel_object[same_height_occupant];
    if (occupant_object >= 0 &&
        g_mandatory_objects[occupant_object] != 0 &&
        g_object_direction[occupant_object] == direction) {
      // A leading momentum body vacates this high-edge cell in the same
      // direction. The follower is part of the convoy, not obstructed by it.
      return direction;
    }
    if (occupant_object >= 0 && g_object_falling[occupant_object] != 0 &&
        g_moving_objects[occupant_object] == 0) {
      // A simultaneous fall vacates the high-edge cell. The following body
      // continues uphill into that source instead of reflecting from a body
      // which is no longer there at the end of this tick.
      return direction;
    }
  }
  // The high edge may open into empty space. Momentum carries the body out at
  // its current elevation and gravity resolves on the following tick. Only a
  // real obstruction (or the room boundary above) reflects it downhill.
  return same_height_occupant < 0
      ? direction
      : OppositeDirection(direction);
}

int32_t SlopeVerticalDelta(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t direction,
    int32_t width,
    int32_t height) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t next_x = voxel.x + kDx[direction];
  const int32_t next_y = voxel.y + kDy[direction];
  if (IsInsideRoom(next_x, next_y, width, height)) {
    const int32_t ascending_slope = FindVoxelAt(
        voxels, next_x, next_y, voxel.z, width, height);
    if (ascending_slope >= 0 &&
        IceSlopeDirection(voxels[ascending_slope].role) == direction) {
      return 1;
    }
  }
  const int32_t support = SlopeSupportingVoxel(
      voxels, voxel, width, height);
  if (support >= 0 &&
      direction == OppositeDirection(IceSlopeDirection(voxels[support].role))) {
    // A descending wedge followed immediately by an ascending wedge at the
    // same base elevation keeps the rider level between their touching faces.
    if (IsInsideRoom(next_x, next_y, width, height) && voxel.z != INT32_MIN) {
      const int32_t next_support = FindVoxelAt(
          voxels, next_x, next_y, voxel.z - 1, width, height);
      if (next_support >= 0 &&
          IceSlopeDirection(voxels[next_support].role) == direction) {
        return 0;
      }
    }
    return -1;
  }
  return 0;
}

int32_t DeliberateSlopeVerticalDelta(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t direction,
    int32_t width,
    int32_t height,
    bool ignore_moving_support) {
  const int32_t slope_delta = SlopeVerticalDelta(
      voxels, voxel, direction, width, height);
  if (slope_delta != -1 || voxel.z == INT32_MIN) return slope_delta;

  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t next_x = voxel.x + kDx[direction];
  const int32_t next_y = voxel.y + kDy[direction];
  if (!IsInsideRoom(next_x, next_y, width, height)) return slope_delta;

  // A deliberate downhill step follows the wedge only when the destination
  // surface is one cell lower. Level support keeps the player level; open
  // space preserves horizontal elevation for this tick and gravity follows.
  const int32_t next_support = FindVoxelAt(
      voxels, next_x, next_y, voxel.z - 1, width, height);
  if (next_support >= 0) {
    if (voxels[next_support].role == kPlayerLiftRole &&
        PlayerLiftIsRaised(voxels[next_support]) &&
        voxels[next_support].generic_id >= 2 &&
        voxels[next_support].generic_id <= 9) {
      return slope_delta;
    }
    const int32_t moving_support = g_voxel_object[next_support];
    const bool weightless_chain_support = ignore_moving_support &&
        moving_support >= 0 &&
        g_object_kind[moving_support] == kWeightlessObject;
    if (!weightless_chain_support &&
        (!ignore_moving_support || moving_support < 0 ||
         g_mandatory_objects[moving_support] == 0)) {
      return 0;
    }
  }
  return FindVoxelAt(
             voxels, next_x, next_y, voxel.z - 2, width, height) >= 0
      ? -1
      : 0;
}

bool SlopeEntryIsBlocked(
    Voxel* voxels,
    const Voxel& voxel,
    int32_t direction,
    int32_t vertical_delta,
    int32_t width,
    int32_t height) {
  if (voxel.z == INT32_MIN) return false;
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t next_x = voxel.x + kDx[direction];
  const int32_t next_y = voxel.y + kDy[direction];
  if (!IsInsideRoom(next_x, next_y, width, height)) return false;
  if (vertical_delta > 0) {
    // An ascending diagonal sweeps the vertical face at the destination.
    // The ramp beneath that face is traversable; a wall or rigid body at the
    // source elevation stops the trajectory even though its endpoint one row
    // higher is empty.
    const int32_t swept = FindVoxelAt(
        voxels, next_x, next_y, voxel.z, width, height);
    return swept >= 0 && !IsIceSlopeRole(voxels[swept].role) &&
        !IsPassThroughVoxel(voxels[swept]);
  }
  if (vertical_delta < 0) return false;
  const int32_t next_support = FindVoxelAt(
      voxels, next_x, next_y, voxel.z - 1, width, height);
  if (next_support < 0 || !IsIceSlopeRole(voxels[next_support].role)) {
    return false;
  }
  // Once on the ramp surface, ordinary directions remain legal. Entering a
  // wedge from adjacent level terrain is possible only through its high edge;
  // its low and side faces are solid at this elevation.
  if (SlopeSupportingVoxel(voxels, voxel, width, height) >= 0) return false;
  return direction != OppositeDirection(
      IceSlopeDirection(voxels[next_support].role));
}

int32_t RedirectMovingObjectSlopeDirection(
    Voxel* voxels,
    int32_t direction,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t redirected = RedirectSlopeDirection(
          voxels, voxels[member], direction, width, height);
      if (redirected != direction) return redirected;
    }
  }
  return direction;
}

int32_t MovingObjectSlopeVerticalDelta(
    Voxel* voxels,
    int32_t direction,
    int32_t width,
    int32_t height) {
  int32_t delta = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t member_delta = SlopeVerticalDelta(
          voxels, voxels[member], direction, width, height);
      if (member_delta == 0) continue;
      if (delta != 0 && delta != member_delta) return 0;
      delta = member_delta;
    }
  }
  return delta;
}

// A terrain lift is stored at its base cell. Even IDs are lowered and odd IDs
// are raised. IDs 0/1 are the upward floor-mounted pair; the remaining pairs
// encode front/right/back/left side mountings. The side orientation is its
// outward direction: raising displaces a rider one cell along that direction.
int32_t PlayerLiftSideOutwardDirection(const Voxel& lift) {
  if (lift.role != kPlayerLiftRole || lift.generic_id < 2 ||
      lift.generic_id > 9) {
    return -1;
  }
  return lift.generic_id / 2 - 1;
}

int32_t PlayerLiftActuatedObjectAt(
    Voxel* voxels,
    int32_t count,
    int32_t x,
    int32_t y,
    int32_t z) {
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].x != x || voxels[index].y != y ||
        voxels[index].z != z) {
      continue;
    }
    const int32_t object = g_voxel_object[index];
    if (object >= 0 && g_object_kind[object] != kMechanismObject) {
      return object;
    }
  }
  return -1;
}

bool TranslatePlayerLiftPayload(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t lift_index,
    int32_t source_x,
    int32_t source_y,
    int32_t source_z,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool commit_translation = true) {
  ClearMovingObjects();
  int32_t seeded = 0;

  // Fixtures mounted to the actuating lift move with its physical cube even
  // though the lift's authored voxel remains at a stable anchor. Build a
  // transitive attachment closure so a button (and future mechanism fixture)
  // mounted on another attached fixture rides in the same transaction.
  const int32_t lift_object = lift_index >= 0 && lift_index < count
      ? g_voxel_object[lift_index]
      : -1;
  if (lift_object >= 0) {
    for (int32_t object = 0; object < g_object_count; ++object) {
      g_component_objects[object] = 0;
    }
    g_component_objects[lift_object] = 1;
    bool added_fixture = true;
    while (added_fixture) {
      added_fixture = false;
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (object == lift_object || g_component_objects[object] != 0 ||
            g_object_kind[object] != kMechanismObject) {
          continue;
        }
        const int32_t fixture = g_object_head[object];
        if (fixture < 0) continue;
        bool attached = OrangeButtonTracksPlayerLift(
            voxels[fixture], voxels[lift_index]);
        if (!attached) {
          const int32_t support = MechanismAttachmentVoxel(
              voxels, object, width, height);
          const int32_t support_object = support >= 0
              ? g_voxel_object[support]
              : -1;
          attached = support_object >= 0 &&
              g_component_objects[support_object] != 0;
        }
        if (!attached) continue;
        g_component_objects[object] = 1;
        g_mandatory_objects[object] = 1;
        g_moving_objects[object] = 1;
        ++seeded;
        added_fixture = true;
      }
    }
  }

  auto seed_at = [&](int32_t x, int32_t y, int32_t z) {
    const int32_t object = PlayerLiftActuatedObjectAt(
        voxels, count, x, y, z);
    if (object >= 0 && g_mandatory_objects[object] == 0) {
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      ++seeded;
    }
  };

  if (dz != 0) {
    // A top lift can share its lowered cell with the bottom voxel of a
    // polycube. It also directly contacts a body one cell above the rider.
    // Seed both contacts, then let the ordinary rigid translation closure
    // move every stacked/carried body as one transactional proposal.
    seed_at(source_x, source_y, source_z);
    if (source_z != INT32_MAX) {
      seed_at(source_x, source_y, source_z + 1);
    }
  } else {
    seed_at(source_x + dx, source_y + dy, source_z);
  }

  if (seeded == 0) {
    const int32_t target_x = source_x + dx;
    const int32_t target_y = source_y + dy;
    const int32_t target_z = source_z + dz;
    const int32_t occupant = FindVoxelAt(
        voxels, target_x, target_y, target_z, width, height);
    return occupant < 0 || occupant == player_index || occupant == lift_index;
  }

  return TranslateMovingObjects(
      voxels,
      count,
      player_index,
      dx,
      dy,
      dz,
      width,
      height,
      false,
      true,
      true,
      true,
      commit_translation);
}

// Only a player that horizontally enters a lowered platform toggles it; a
// rider carried by another body does not retrigger it.
int32_t PlayerLiftAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool& raise) {
  const Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height)) return -1;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y) {
      continue;
    }
    if (lift.generic_id < 0 || lift.generic_id > 9) continue;
    if (!PlayerLiftIsRaised(lift) && lift.z == player.z) {
      raise = true;
      return index;
    }
    if (lift.generic_id <= 1 && PlayerLiftIsRaised(lift) &&
        player.z != INT32_MIN &&
        lift.z == player.z - 1) {
      raise = false;
      return index;
    }
  }
  return -1;
}

int32_t PlayerLiftCountAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height)) return 0;
  int32_t matches = 0;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.generic_id < 0 ||
        lift.generic_id > 9) {
      continue;
    }
    if ((!PlayerLiftIsRaised(lift) && lift.z == player.z) ||
        (lift.generic_id <= 1 && PlayerLiftIsRaised(lift) &&
         player.z != INT32_MIN && lift.z == player.z - 1)) {
      ++matches;
    }
  }
  return matches;
}

bool TranslateSlopeMomentumObjects(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool allow_push,
    bool pushed_targets_require_ice,
    bool allow_downhill_contact_push,
    bool player_moves_horizontally,
    bool& player_was_pushed);

// Several pass-through fixtures may deliberately share a voxel. An overlap
// is not an ordering rule: incompatible lifts cancel instead of allowing the
// first voxel in storage to win. The unambiguous multi-lift arrangement is a
// balanced set of opposed side lifts, each mounted to a distinct movable
// body. In that case the trapped rider stays centered and the mounted bodies
// receive the equal-and-opposite recoil proposals in one transaction.
bool OverlappingPlayerLiftsCanRecoil(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  constexpr int32_t kMaximumDirections = 4;
  int32_t support_objects[kMaximumDirections] = {-1, -1, -1, -1};
  uint8_t directions = 0;
  int32_t matches = 0;
  const Voxel& player = voxels[player_index];
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.z != player.z ||
        PlayerLiftIsRaised(lift)) {
      continue;
    }
    const int32_t outward = PlayerLiftSideOutwardDirection(lift);
    const int32_t lift_object = g_voxel_object[index];
    if (outward < 0 || lift_object < 0 || matches >= kMaximumDirections ||
        (directions & (1u << outward)) != 0) {
      return false;
    }
    const int32_t attachment = PlayerLiftSideAttachmentVoxel(
        voxels, lift_object, width, height);
    const int32_t support_object = attachment >= 0
        ? g_voxel_object[attachment]
        : -1;
    if (support_object < 0 || support_object == lift_object ||
        g_object_kind[support_object] == kMechanismObject) {
      return false;
    }
    for (int32_t prior = 0; prior < matches; ++prior) {
      if (support_objects[prior] == support_object) return false;
    }
    support_objects[matches++] = support_object;
    directions |= static_cast<uint8_t>(1u << outward);
  }
  if (matches < 2) return false;
  const bool north_south_balanced =
      ((directions & 0b0001u) != 0) == ((directions & 0b0100u) != 0);
  const bool east_west_balanced =
      ((directions & 0b0010u) != 0) == ((directions & 0b1000u) != 0);
  return north_south_balanced && east_west_balanced;
}

bool RecoilOverlappingPlayerLifts(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  if (!OverlappingPlayerLiftsCanRecoil(
          voxels, count, player_index, width, height)) {
    return false;
  }

  ClearMovingObjects();
  const Voxel& player = voxels[player_index];
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.z != player.z ||
        PlayerLiftIsRaised(lift)) {
      continue;
    }
    const int32_t lift_object = g_voxel_object[index];
    const int32_t attachment = PlayerLiftSideAttachmentVoxel(
        voxels, lift_object, width, height);
    const int32_t support_object = g_voxel_object[attachment];
    const int32_t recoil = OppositeDirection(
        PlayerLiftSideOutwardDirection(lift));
    g_mandatory_objects[lift_object] = 1;
    g_moving_objects[lift_object] = 1;
    g_object_direction[lift_object] = static_cast<uint8_t>(recoil);
    g_mandatory_objects[support_object] = 1;
    g_moving_objects[support_object] = 1;
    g_object_direction[support_object] = static_cast<uint8_t>(recoil);
  }

  // Fixtures attached to either recoiling body inherit that body's proposal.
  // This is a transitive closure so buttons and future surface mechanisms do
  // not detach merely because the lift event has more than one direction.
  bool added_fixture = true;
  while (added_fixture) {
    added_fixture = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0 ||
          g_object_kind[object] != kMechanismObject) {
        continue;
      }
      const int32_t attachment = MechanismAttachmentVoxel(
          voxels, object, width, height);
      const int32_t support_object = attachment >= 0
          ? g_voxel_object[attachment]
          : -1;
      if (support_object < 0 || g_mandatory_objects[support_object] == 0) {
        continue;
      }
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      g_object_direction[object] = g_object_direction[support_object];
      added_fixture = true;
    }
  }

  // Raised state participates in collision validation. Voxel indices remain
  // stable during the transaction, so a rejected proposal can restore every
  // participating lift without a scene copy.
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && !PlayerLiftIsRaised(lift) &&
        lift.x == player.x && lift.y == player.y && lift.z == player.z) {
      ++lift.generic_id;
    }
  }
  bool player_was_pushed = false;
  const bool moved = TranslateSlopeMomentumObjects(
      voxels,
      count,
      player_index,
      width,
      height,
      true,
      false,
      false,
      false,
      player_was_pushed);
  if (moved) return true;
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && PlayerLiftIsRaised(lift) &&
        lift.x == player.x && lift.y == player.y && lift.z == player.z) {
      --lift.generic_id;
    }
  }
  return false;
}

bool PlayerLiftCanToggleOnEntry(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t from_x,
    int32_t from_y,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  if (player.x == from_x && player.y == from_y) return false;
  const int32_t lift_count = PlayerLiftCountAtPlayer(
      voxels, count, player_index, width, height);
  if (lift_count > 1) {
    return OverlappingPlayerLiftsCanRecoil(
        voxels, count, player_index, width, height);
  }
  bool raise = false;
  const int32_t lift_index = PlayerLiftAtPlayer(
      voxels, count, player_index, width, height, raise);
  if (lift_index < 0) return false;
  if (!raise) return true;
  const Voxel& lift = voxels[lift_index];
  if (PlayerLiftSideOutwardDirection(lift) >= 0) {
    const int32_t direction = PlayerLiftSideOutwardDirection(lift);
    constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
    constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
    return IsInsideRoom(
        lift.x + kLiftDx[direction],
        lift.y + kLiftDy[direction],
        width,
        height);
  }
  return player.z != INT32_MAX;
}

bool RaiseVacatedUpwardPlayerLift(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t from_x,
    int32_t from_y,
    int32_t from_z,
    bool allow_top_lift) {
  const Voxel& player = voxels[player_index];
  if (player.x == from_x && player.y == from_y && player.z == from_z) {
    return false;
  }
  int32_t lowered_lifts = 0;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    lowered_lifts += lift.role == kPlayerLiftRole && lift.generic_id >= 0 &&
        lift.generic_id <= 9 && lift.generic_id % 2 == 0 &&
        lift.x == from_x && lift.y == from_y && lift.z == from_z
        ? 1
        : 0;
  }
  if (lowered_lifts > 1) return false;
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && lift.generic_id >= 0 &&
        lift.generic_id <= 9 && lift.generic_id % 2 == 0 &&
        (allow_top_lift || lift.generic_id >= 2) &&
        lift.x == from_x && lift.y == from_y && lift.z == from_z) {
      // A blocked or voluntarily departing rider leaves the lowered fixture
      // behind. With nobody to actuate, every mounting returns to its raised
      // state without pushing the contents of its outward cell.
      if (lift.generic_id <= 1) {
        for (int32_t button_index = 0; button_index < count; ++button_index) {
          Voxel& button = voxels[button_index];
          if (!OrangeButtonTracksPlayerLift(button, lift)) continue;
          if (button.z != INT32_MAX) ++button.z;
          if (button.generic_id >= 0) button.generic_id &= ~1;
        }
      }
      ++lift.generic_id;
      return true;
    }
  }
  return false;
}

bool VacatedUpwardPlayerLiftNeedsRetry(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  int32_t lift_index = -1;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.generic_id != 0 ||
        lift.x != player.x || lift.y != player.y || lift.z != player.z) {
      continue;
    }
    if (lift_index >= 0) return false;
    lift_index = index;
  }
  if (lift_index < 0 || player.z == INT32_MAX) return false;

  // Probe the lift transaction without committing it. A lowered lift which
  // could have raised its rider is an authored stable state and stays down
  // after departure. Only a lift whose attempted rise was obstructed earns a
  // one-tick retry after the rider has moved clear.
  return !TranslatePlayerLiftPayload(
      voxels,
      count,
      player_index,
      lift_index,
      player.x,
      player.y,
      player.z,
      0,
      0,
      1,
      width,
      height,
      false);
}

bool TogglePlayerLiftAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  Voxel& player = voxels[player_index];
  if (PlayerLiftCountAtPlayer(
          voxels, count, player_index, width, height) > 1) {
    return RecoilOverlappingPlayerLifts(
        voxels, count, player_index, width, height);
  }
  bool raise = false;
  const int32_t lift_index = PlayerLiftAtPlayer(
      voxels, count, player_index, width, height, raise);
  if (lift_index < 0) return false;

  if (raise) {
    const int32_t outward = PlayerLiftSideOutwardDirection(
        voxels[lift_index]);
    if (outward >= 0) {
      constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
      constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
      const int32_t target_x = player.x + kLiftDx[outward];
      const int32_t target_y = player.y + kLiftDy[outward];
      if (!IsInsideRoom(target_x, target_y, width, height) ||
          !TranslatePlayerLiftPayload(
              voxels,
              count,
              player_index,
              lift_index,
              player.x,
              player.y,
              player.z,
              kLiftDx[outward],
              kLiftDy[outward],
              0,
              width,
              height)) {
        return false;
      }
      ++voxels[lift_index].generic_id;
      player.x = target_x;
      player.y = target_y;
      return true;
    }
    if (player.z == INT32_MAX ||
        !TranslatePlayerLiftPayload(
            voxels,
            count,
            player_index,
            lift_index,
            player.x,
            player.y,
            player.z,
            0,
            0,
            1,
            width,
            height)) {
      return false;
    }
    ++voxels[lift_index].generic_id;
    ++player.z;
  } else {
    if (!TranslatePlayerLiftPayload(
            voxels,
            count,
            player_index,
            lift_index,
            player.x,
            player.y,
            player.z,
            0,
            0,
            -1,
            width,
            height)) {
      return false;
    }
    --voxels[lift_index].generic_id;
    --player.z;
  }
  return true;
}

bool SceneHasIceSlopes(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  const WorkspaceData& workspace = ActiveWorkspace();
  if (workspace.prepared_voxels == voxels &&
      workspace.prepared_count == count &&
      workspace.prepared_width == width &&
      workspace.prepared_height == height) {
    return workspace.prepared_has_ice_slopes;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (IsIceSlopeRole(voxels[index].role)) return true;
  }
  return false;
}

void PrepareSlopeObjectProposal(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height,
    bool allow_redirect,
    bool deliberate_vertical = false) {
  constexpr int8_t kDx[] = {0, 1, 0, -1};
  constexpr int8_t kDy[] = {-1, 0, 1, 0};
  int32_t direction = g_object_direction[object] <= 3
      ? g_object_direction[object]
      : 0;
  if (allow_redirect) {
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t redirected = RedirectSlopeDirection(
          voxels, voxels[member], direction, width, height);
      if (redirected != direction) {
        direction = redirected;
        g_object_redirected[object] = 1;
        break;
      }
    }
  }
  g_object_direction[object] = static_cast<uint8_t>(direction);
  g_object_dx[object] = kDx[direction];
  g_object_dy[object] = kDy[direction];
  bool has_vertical_stack = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (voxels[member].z == INT32_MIN) continue;
    const int32_t below = FindVoxelAt(
        voxels,
        voxels[member].x,
        voxels[member].y,
        voxels[member].z - 1,
        width,
        height);
    if (below >= 0 && g_voxel_object[below] == object) {
      has_vertical_stack = true;
      break;
    }
  }

  int32_t dz = 0;
  bool has_vertical_constraint = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t member_dz = deliberate_vertical
        ? DeliberateSlopeVerticalDelta(
              voxels, voxels[member], direction, width, height, true)
        : SlopeVerticalDelta(
              voxels, voxels[member], direction, width, height);

    // Only exposed feet constrain a rigid body's ramp elevation. Internal
    // members stacked above the same polycube do not vote a second time, and
    // unsupported overhangs follow the supported portion. A level external
    // foot is significant: a tall polycube cannot descend through that foot
    // merely because another part of the same body rests on a wedge.
    int32_t support = -1;
    if (voxels[member].z != INT32_MIN) {
      support = FindVoxelAt(
          voxels,
          voxels[member].x,
          voxels[member].y,
          voxels[member].z - 1,
          width,
          height);
    }
    if (support >= 0 && g_voxel_object[support] == object) continue;
    if (has_vertical_stack) {
      if (support < 0 && member_dz <= 0) continue;
    } else if (member_dz == 0) {
      continue;
    }

    if (has_vertical_constraint && dz != member_dz) {
      dz = 0;
      break;
    }
    dz = member_dz;
    has_vertical_constraint = true;
  }
  g_object_dz[object] = static_cast<int8_t>(dz);
}

int32_t ObjectDownhillSlopeDirection(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  int32_t downhill = -1;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t support = SlopeSupportingVoxel(
        voxels, voxels[member], width, height);
    if (support < 0) continue;
    const int32_t member_downhill = OppositeDirection(
        IceSlopeDirection(voxels[support].role));
    if (downhill >= 0 && downhill != member_downhill) return -1;
    downhill = member_downhill;
  }
  return downhill;
}

bool ObjectHasConflictingSlopeSupports(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  int32_t downhill = -1;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t support = SlopeSupportingVoxel(
        voxels, voxels[member], width, height);
    if (support < 0) continue;
    const int32_t member_downhill = OppositeDirection(
        IceSlopeDirection(voxels[support].role));
    if (downhill >= 0 && downhill != member_downhill) return true;
    downhill = member_downhill;
  }
  return false;
}

bool ObjectBridgesSlopeAndFlatIce(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  bool has_slope_support = false;
  bool has_flat_ice_support = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support < 0 || g_voxel_object[support] == object) continue;
    has_slope_support |= IsIceSlopeRole(voxels[support].role);
    has_flat_ice_support |= voxels[support].role == kIceRole;
  }
  return has_slope_support && has_flat_ice_support;
}

bool ObjectProposalVacatesCell(
    Voxel* voxels,
    int32_t object,
    int32_t x,
    int32_t y,
    int32_t z);

bool AddAutonomousSlopeObjects(
    Voxel* voxels,
    int32_t player_index,
    int32_t player_direction,
    int32_t width,
    int32_t height,
    bool preserve_deliberate_proposals = false) {
  bool added = false;
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const Voxel& player = voxels[player_index];
  const int32_t player_target_x = player.x + kDx[player_direction];
  const int32_t player_target_y = player.y + kDy[player_direction];
  const int32_t player_target_z = player.z + DeliberateSlopeVerticalDelta(
      voxels,
      player,
      player_direction,
      width,
      height,
      false);
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_deferred_slope_objects[object] = 0;
  }

  // The command direction advances matching ramps everywhere. Other ramp
  // directions awaken only when their downhill proposal enters a source cell
  // being vacated in this tick; this is what makes perpendicular ramp chains
  // propagate without making unrelated bodies elsewhere in the room move.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height) ||
        !ObjectIsFullyOnIce(voxels, object, width, height)) {
      continue;
    }
    bool supports_player_target = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].x == player_target_x &&
          voxels[member].y == player_target_y &&
          voxels[member].z == player_target_z - 1) {
        supports_player_target = true;
        break;
      }
    }
    if (supports_player_target) continue;
    if (MovingSupportBelowObject(
            voxels,
            object,
            player_index,
            false,
            width,
            height) >= 0) {
      // Carrier motion wins for this synchronized tick. A rider resting on a
      // movable ramp follows that ramp's exact 3D proposal first; after the
      // commit PreserveMovableSlopeRiderMomentum may arm the rider's own
      // downhill motion for the following tick.
      continue;
    }
    const int32_t downhill = ObjectDownhillSlopeDirection(
        voxels, object, width, height);
    if (downhill < 0 || downhill != player_direction ||
        ObjectBridgesSlopeAndFlatIce(voxels, object, width, height)) {
      // A rigid body bridging a wedge and level Ice has a stable level foot.
      // It can still be deliberately pushed, but slope gravity alone cannot
      // move it without changing its shape.
      continue;
    }
    g_object_direction[object] = static_cast<uint8_t>(downhill);
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    added = true;
  }

  bool propagated = true;
  while (propagated) {
    propagated = false;
    for (int32_t moving = 0; moving < g_object_count; ++moving) {
      if (g_mandatory_objects[moving] != 0) {
        // This is the command's initial synchronized proposal. Deliberately
        // pushed bodies keep the command direction; slope redirection begins
        // only on their subsequent momentum ticks.
        PrepareSlopeObjectProposal(
            voxels,
            moving,
            width,
            height,
            false,
            preserve_deliberate_proposals);
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0 ||
          g_object_kind[object] == kMechanismObject ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      const int32_t downhill = ObjectDownhillSlopeDirection(
          voxels, object, width, height);
      if (downhill < 0) continue;
      const uint8_t previous_direction = g_object_direction[object];
      g_object_direction[object] = static_cast<uint8_t>(downhill);
      PrepareSlopeObjectProposal(voxels, object, width, height, false);
      bool enters_vacated_source = false;
      int32_t vacating_direction = player_direction;
      bool vacating_is_deferred = false;
      for (int32_t member = g_object_head[object]; member >= 0 &&
           !enters_vacated_source; member = g_next_object_voxel[member]) {
        const int32_t next_x = voxels[member].x + kDx[downhill];
        const int32_t next_y = voxels[member].y + kDy[downhill];
        const int32_t next_z = voxels[member].z + g_object_dz[object];
        if (voxels[player_index].x == next_x &&
            voxels[player_index].y == next_y &&
            voxels[player_index].z == next_z) {
          enters_vacated_source = true;
          break;
        }
        const int32_t occupant = FindVoxelAt(
            voxels, next_x, next_y, next_z, width, height);
        const int32_t other = occupant >= 0 ? g_voxel_object[occupant] : -1;
        enters_vacated_source = other >= 0 &&
            (g_mandatory_objects[other] != 0 ||
             g_deferred_slope_objects[other] != 0) &&
            ObjectProposalVacatesCell(
                voxels, other, next_x, next_y, next_z);
        if (enters_vacated_source) {
          vacating_direction = g_object_direction[other];
          vacating_is_deferred =
              g_deferred_slope_objects[other] != 0;
        }
      }
      if (!enters_vacated_source) {
        // Computing an autonomous proposal is speculative. Leaving the
        // downhill direction behind on an object that was not recruited
        // makes the carrier pass mistake an ordinary ramp rider for a body
        // with independent latent momentum, so it gets left behind when its
        // movable ramp translates on another axis.
        g_object_direction[object] = previous_direction;
        continue;
      }
      if (vacating_is_deferred || downhill != vacating_direction) {
        // The source cell is available only after the other body's proposal
        // commits. Preserve this body's own downhill direction as momentum
        // for the next tick instead of dragging it along the vacating axis.
        const bool newly_deferred = g_deferred_slope_objects[object] == 0;
        g_deferred_slope_objects[object] = 1;
        added = true;
        propagated |= newly_deferred;
        continue;
      }
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      added = true;
      propagated = true;
    }
  }
  return added;
}

bool DeferredSlopeProposalIsClear(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height);

bool PromoteDeferredSlopeMomentum(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  bool promoted = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_deferred_slope_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    const int32_t downhill = ObjectDownhillSlopeDirection(
        voxels, object, width, height);
    if (downhill < 0) continue;
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>(downhill);
    if (!DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height)) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      continue;
    }
    promoted = true;
  }
  return promoted;
}

bool SlopeObjectProposalEntersPlayerFromDifferentDirection(
    Voxel* voxels,
    int32_t player_index,
    int32_t player_dx,
    int32_t player_dy,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    PrepareSlopeObjectProposal(voxels, object, width, height, true);
    if (g_object_dx[object] == player_dx &&
        g_object_dy[object] == player_dy) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].x + g_object_dx[object] == player.x &&
          voxels[member].y + g_object_dy[object] == player.y &&
          voxels[member].z + g_object_dz[object] == player.z) {
        return true;
      }
    }
  }
  return false;
}

int32_t UphillSlopeContactObject(
    Voxel* voxels,
    const Voxel& source,
    int32_t movement_direction,
    int32_t width,
    int32_t height) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t maximum_steps = width > height ? width : height;
  for (int32_t slope_direction = 0; slope_direction < 4;
       ++slope_direction) {
    if (slope_direction == movement_direction ||
        slope_direction == OppositeDirection(movement_direction)) {
      continue;
    }
    for (int32_t step = 1; step <= maximum_steps; ++step) {
      const int32_t candidate_x = source.x + kDx[slope_direction] * step;
      const int32_t candidate_y = source.y + kDy[slope_direction] * step;
      const int32_t candidate_z = source.z + step;
      if (!IsInsideRoom(candidate_x, candidate_y, width, height)) break;
      const int32_t support = FindVoxelAt(
          voxels,
          candidate_x,
          candidate_y,
          candidate_z - 1,
          width,
          height);
      if (support < 0 || !IsIceSlopeRole(voxels[support].role) ||
          IceSlopeDirection(voxels[support].role) != slope_direction) {
        break;
      }
      const int32_t occupant = FindVoxelAt(
          voxels, candidate_x, candidate_y, candidate_z, width, height);
      if (occupant >= 0 && g_voxel_object[occupant] >= 0 &&
          g_object_kind[g_voxel_object[occupant]] == kWeightlessObject) {
        return g_voxel_object[occupant];
      }
    }
  }
  return -1;
}

void AddDeliberateUphillSlopeContactClosure(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  bool added = true;
  while (added) {
    added = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0 ||
          g_object_kind[object] != kWeightlessObject) {
        continue;
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const int32_t uphill = UphillSlopeContactObject(
            voxels,
            voxels[member],
            g_object_direction[object],
            width,
            height);
        if (uphill < 0 || g_mandatory_objects[uphill] != 0 ||
            g_object_falling[uphill] != 0) {
          continue;
        }
        g_mandatory_objects[uphill] = 1;
        g_moving_objects[uphill] = 1;
        g_object_direction[uphill] = g_object_direction[object];
        added = true;
      }
    }
  }
}

bool DeferredSlopeProposalIsClear(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  PrepareSlopeObjectProposal(voxels, object, width, height, false);
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t next_x = voxels[member].x + g_object_dx[object];
    const int32_t next_y = voxels[member].y + g_object_dy[object];
    const int32_t next_z = voxels[member].z + g_object_dz[object];
    if (!IsInsideRoom(next_x, next_y, width, height)) return false;
    const int32_t occupant = FindVoxelAt(
        voxels, next_x, next_y, next_z, width, height);
    if (occupant < 0 || occupant == player_index ||
        g_voxel_object[occupant] == object) {
      continue;
    }
    const int32_t other = g_voxel_object[occupant];
    if (other >= 0 && g_deferred_slope_objects[other] != 0 &&
        ObjectProposalVacatesCell(
            voxels, other, next_x, next_y, next_z)) {
      continue;
    }
    return false;
  }
  return true;
}

bool ObjectProposalVacatesCell(
    Voxel* voxels,
    int32_t object,
    int32_t x,
    int32_t y,
    int32_t z) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (voxels[member].x + g_object_dx[object] == x &&
        voxels[member].y + g_object_dy[object] == y &&
        voxels[member].z + g_object_dz[object] == z) {
      return false;
    }
  }
  return true;
}

bool ObjectProposalsSwap(
    Voxel* voxels,
    int32_t first,
    int32_t second) {
  for (int32_t first_member = g_object_head[first]; first_member >= 0;
       first_member = g_next_object_voxel[first_member]) {
    const int32_t first_x = voxels[first_member].x;
    const int32_t first_y = voxels[first_member].y;
    const int32_t first_z = voxels[first_member].z;
    const int32_t first_next_x = first_x + g_object_dx[first];
    const int32_t first_next_y = first_y + g_object_dy[first];
    const int32_t first_next_z = first_z + g_object_dz[first];
    for (int32_t second_member = g_object_head[second]; second_member >= 0;
         second_member = g_next_object_voxel[second_member]) {
      const int32_t second_x = voxels[second_member].x;
      const int32_t second_y = voxels[second_member].y;
      const int32_t second_z = voxels[second_member].z;
      if (first_next_x == second_x && first_next_y == second_y &&
          first_next_z == second_z &&
          second_x + g_object_dx[second] == first_x &&
          second_y + g_object_dy[second] == first_y &&
          second_z + g_object_dz[second] == first_z) {
        return true;
      }
    }
  }
  return false;
}

void AddSlopeCarriedObjects(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool preserve_matching_latent_motion) {
  BuildCarriedObjects(voxels, player_index, false, width, height);
  bool promoted = true;
  while (promoted) {
    promoted = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_carried_objects[object] == 0) continue;
      const int32_t carrier = g_carrier_parent[object];
      bool carrier_is_movable_ramp = false;
      if (carrier >= 0) {
        for (int32_t member = g_object_head[carrier]; member >= 0;
             member = g_next_object_voxel[member]) {
          carrier_is_movable_ramp |=
              IsBlueBoxSlopeRole(voxels[member].role) ||
              IsYellowCloneSlopeRole(voxels[member].role);
        }
      }
      const bool rider_continues_before_redirect =
          preserve_matching_latent_motion && carrier >= 0 &&
          !carrier_is_movable_ramp &&
          g_object_direction[object] <= 3 &&
          g_object_direction[object] == g_component_indegree[carrier];
      if (g_object_falling[object] != 0 ||
          (g_mandatory_objects[object] != 0 &&
           g_object_direction[object] <= 3 &&
           !carrier_is_movable_ramp) ||
          rider_continues_before_redirect) {
        // A body already committed to gravity or to an active horizontal
        // proposal keeps that proposal as support departs. A latent falling
        // stack which arrived with its carrier also continues vertically when
        // that support moves out underneath it. Otherwise, a body arriving
        // from another axis has just been caught and follows its carrier.
        g_carried_objects[object] = 0;
        g_moving_objects[object] = g_mandatory_objects[object];
        g_carrier_parent[object] = -1;
        continue;
      }
      if (g_mandatory_objects[object] != 0) {
        continue;
      }
      if (carrier < 0 || g_mandatory_objects[carrier] == 0) continue;
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      g_object_direction[object] = g_object_direction[carrier];
      g_object_dx[object] = g_object_dx[carrier];
      g_object_dy[object] = g_object_dy[carrier];
      g_object_dz[object] = g_object_dz[carrier];
      promoted = true;
    }
  }
}

void PreserveSlopeCarriedMomentum(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  // Carried stacks continue only while the bottom carrier still has slippery
  // support.  This avoids granting a rider an extra tick when the carrier has
  // just reached Wall/Floor, while preserving a whole stack over continuing
  // Ice (including a body partly supported by its moving carrier).
  for (int32_t pass = 0; pass < g_object_count; ++pass) {
    bool changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      const int32_t carrier = g_carrier_parent[object];
      if (carrier < 0) continue;
      const bool carrier_continues = carrier >= 0 &&
          (ObjectIsFullyOnIce(voxels, carrier, width, height) ||
           g_inherited_support_motion[carrier] != 0);
      const uint8_t inherited = carrier_continues
          ? static_cast<uint8_t>(g_object_direction[object] + 1)
          : 0;
      if (g_inherited_support_motion[object] != inherited) {
        g_inherited_support_motion[object] = inherited;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

void PreserveMovableSlopeRiderMomentum(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] == 0 ||
        g_object_redirected[object] == 2) {
      continue;
    }
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
      const int32_t carrier = support >= 0 ? g_voxel_object[support] : -1;
      if (carrier < 0 || carrier == object ||
          g_moving_objects[carrier] == 0 ||
          (!IsBlueBoxSlopeRole(voxels[support].role) &&
           !IsYellowCloneSlopeRole(voxels[support].role))) {
        continue;
      }
      g_inherited_support_motion[object] = static_cast<uint8_t>(
          OppositeDirection(IceSlopeDirection(voxels[support].role)) + 1);
      break;
    }
  }
}

bool ObjectCurrentSlopeProposalIsBlocked(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_moves_horizontally) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t next_x = voxels[member].x + g_object_dx[object];
    const int32_t next_y = voxels[member].y + g_object_dy[object];
    const int32_t next_z = voxels[member].z + g_object_dz[object];
    if (!IsInsideRoom(next_x, next_y, width, height)) return true;
    const int32_t occupant = FindVoxelAt(
        voxels, next_x, next_y, next_z, width, height);
    if (occupant < 0 || g_voxel_object[occupant] == object) continue;
    if (occupant == player_index) return !player_moves_horizontally;
    const int32_t other = g_voxel_object[occupant];
    if (other >= 0 && g_mandatory_objects[other] != 0 &&
        ObjectProposalVacatesCell(
            voxels, other, next_x, next_y, next_z)) {
      continue;
    }
    return true;
  }
  return false;
}

// A movable ramp that advances low-edge-first into a horizontally trapped
// weightless body wedges underneath it. The ramp keeps its horizontal
// proposal while the trapped body converts its failed horizontal proposal to
// one vertical step. Untrapped bodies retain the ordinary push closure.
void ConvertTrappedBodiesToMovableSlopeLifts(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_moves_horizontally) {
  for (int32_t slope_object = 0; slope_object < g_object_count;
       ++slope_object) {
    if (g_mandatory_objects[slope_object] == 0 ||
        (g_object_kind[slope_object] != kWeightlessObject &&
         g_object_kind[slope_object] != kCloneObject)) {
      continue;
    }
    const int32_t movement_direction = g_object_direction[slope_object];
    if (movement_direction < 0 || movement_direction > 3) continue;
    for (int32_t member = g_object_head[slope_object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const uint32_t role = voxels[member].role;
      if ((!IsBlueBoxSlopeRole(role) && !IsYellowCloneSlopeRole(role)) ||
          IceSlopeDirection(role) != OppositeDirection(movement_direction)) {
        continue;
      }
      const int32_t next_x = voxels[member].x + g_object_dx[slope_object];
      const int32_t next_y = voxels[member].y + g_object_dy[slope_object];
      const int32_t next_z = voxels[member].z + g_object_dz[slope_object];
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, next_z, width, height);
      if (occupant < 0) continue;
      const int32_t lifted = g_voxel_object[occupant];
      if (lifted < 0 || lifted == slope_object ||
          g_object_kind[lifted] != kWeightlessObject ||
          g_mandatory_objects[lifted] == 0 ||
          !ObjectCurrentSlopeProposalIsBlocked(
              voxels,
              lifted,
              player_index,
              width,
              height,
              player_moves_horizontally)) {
        continue;
      }
      g_object_dx[lifted] = 0;
      g_object_dy[lifted] = 0;
      g_object_dz[lifted] = 1;
      // Reflection propagation has already completed, so value 2 is a local
      // marker for this converted vertical proposal. It is cleared before
      // returning to the tick state machine.
      g_object_redirected[lifted] = 2;
    }
  }
}

// Directional slope motion is transactional at the object level. Each rigid
// polycube owns its direction and vertical ramp delta; only a head-on contact
// with a reflected body propagates that reflection through a touching convoy.
// This keeps separated bodies independent while preventing them from swapping
// through one another when the lead body bounces off a ramp obstruction.
bool TranslateSlopeMomentumObjects(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool allow_push,
    bool pushed_targets_require_ice,
    bool allow_downhill_contact_push,
    bool player_moves_horizontally,
    bool& player_was_pushed) {
  player_was_pushed = false;
  g_moving_objects_fell = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_fell_objects[object] = 0;
    g_object_redirected[object] = 0;
    g_inherited_support_motion[object] = 0;
    g_component_objects[object] = 0;
    // This scratch array is not needed for component topology until the
    // later gravity pass, so retain each proposal's pre-slope direction here.
    g_component_indegree[object] = g_object_direction[object];
    if (g_deferred_slope_objects[object] != 0) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
    } else if (g_mandatory_objects[object] != 0) {
      g_moving_objects[object] = 1;
      if (allow_downhill_contact_push) {
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          if (SlopeSupportingVoxel(
                  voxels, voxels[member], width, height) >= 0) {
            g_component_objects[object] = 1;
            break;
          }
        }
      }
    }
  }

  // A deliberate push discovers the whole touching weightless chain using
  // each body's own slope-adjusted destination.
  bool added = true;
  while (added) {
    added = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0 ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      PrepareSlopeObjectProposal(
          voxels, object, width, height, !allow_push, allow_push);
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const int32_t next_x = voxels[member].x + g_object_dx[object];
        const int32_t next_y = voxels[member].y + g_object_dy[object];
        const int32_t next_z = voxels[member].z + g_object_dz[object];
        if (!IsInsideRoom(next_x, next_y, width, height)) continue;
        const int32_t occupant = FindVoxelAt(
            voxels, next_x, next_y, next_z, width, height);
        if (occupant < 0 || occupant == player_index) continue;
        const int32_t other = g_voxel_object[occupant];
        if (other < 0 || other == object ||
            g_mandatory_objects[other] != 0) {
          continue;
        }
        if (g_object_falling[other] != 0) {
          // A falling body vacates its source vertically; it must not be
          // recruited into the horizontal push closure.
          continue;
        }
        // A deliberate shove always recruits a touching weightless body.
        // Automatic momentum does so only while descending a ramp: that is a
        // synchronized landing/contact, whereas a body already sliding on a
        // level surface stops when it reaches a stationary body.
        bool source_is_movable_ramp = false;
        for (int32_t source_member = g_object_head[object];
             source_member >= 0;
             source_member = g_next_object_voxel[source_member]) {
          source_is_movable_ramp |=
              IsBlueBoxSlopeRole(voxels[source_member].role) ||
              IsYellowCloneSlopeRole(voxels[source_member].role);
        }
        const bool slope_derived_contact = source_is_movable_ramp &&
            ObjectDownhillSlopeDirection(
                voxels, object, width, height) >= 0;
        const bool deliberate_contact_push = allow_push &&
            ((!pushed_targets_require_ice && !slope_derived_contact) ||
             ObjectIsFullyOnIce(voxels, other, width, height));
        const bool downhill_ice_contact_push =
            allow_downhill_contact_push && g_component_objects[object] != 0 &&
            ObjectIsFullyOnIce(voxels, other, width, height);
        const bool recruit_deliberate = deliberate_contact_push &&
            DeliberatePushMayRecruit(object, other);
        const bool recruit_downhill = downhill_ice_contact_push &&
            (g_object_kind[object] == kWeightlessObject ||
             g_object_kind[object] == kCloneObject ||
             g_object_kind[object] == kPlayerObject) &&
            g_object_kind[other] == kWeightlessObject;
        if (recruit_deliberate || recruit_downhill) {
          g_mandatory_objects[other] = 1;
          g_moving_objects[other] = 1;
          g_object_direction[other] = g_object_direction[object];
          g_component_objects[other] = g_component_objects[object];
          added = true;
        }
      }
    }
  }

  // Autonomous downhill motion is discovered before the deliberate contact
  // closure knows every body that the command will move. Once that closure
  // is complete, a moving support takes precedence for this synchronized
  // tick: demote its horizontally armed rider so AddSlopeCarriedObjects can
  // copy the carrier's exact 3D proposal. This is a support-graph rule, not a
  // role-specific exception: a body resting on another moving body rides it
  // before acquiring any new downhill momentum from the resulting support.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    bool rider_is_movable_ramp = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      rider_is_movable_ramp |=
          IsBlueBoxSlopeRole(voxels[member].role) ||
          IsYellowCloneSlopeRole(voxels[member].role);
    }
    if (!rider_is_movable_ramp) continue;
    if (MovingSupportBelowObject(
            voxels,
            object,
            player_index,
            false,
            width,
            height) < 0) {
      continue;
    }
    g_mandatory_objects[object] = 0;
    g_moving_objects[object] = 0;
  }

  // A slope reflection propagates through exact head-on contacts. Recompute
  // after every propagation because adjacent bodies can be on different ramp
  // elevations even though their horizontal speed is identical.
  bool propagated = true;
  while (propagated) {
    propagated = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0) {
        PrepareSlopeObjectProposal(
            voxels, object, width, height, !allow_push, allow_push);
      }
    }
    for (int32_t first = 0; first < g_object_count; ++first) {
      if (g_mandatory_objects[first] == 0 ||
          g_object_redirected[first] == 0) {
        continue;
      }
      for (int32_t second = 0; second < g_object_count; ++second) {
        if (first == second || g_mandatory_objects[second] == 0 ||
            g_object_direction[first] == g_object_direction[second] ||
            !ObjectProposalsSwap(voxels, first, second)) {
          continue;
        }
        g_object_direction[second] = g_object_direction[first];
        g_object_redirected[second] = 1;
        PrepareSlopeObjectProposal(
            voxels, second, width, height, false, allow_push);
        propagated = true;
      }
    }
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_deferred_slope_objects[object] != 0) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      continue;
    }
    if (g_mandatory_objects[object] != 0) {
      PrepareSlopeObjectProposal(
          voxels, object, width, height, false, allow_push);
    }
  }

  ConvertTrappedBodiesToMovableSlopeLifts(
      voxels,
      player_index,
      width,
      height,
      player_moves_horizontally);

  // Slope proposals can have a different vertical delta per object, so the
  // ordinary uniform-delta carrier path cannot be used directly. Discover
  // the same support graph, then copy each carrier's exact 3D proposal to its
  // riders before validating the transaction.
  AddSlopeCarriedObjects(
      voxels, player_index, width, height, !allow_push);

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    if (allow_push &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels,
            object,
            g_object_dx[object],
            g_object_dy[object],
            g_object_dz[object],
            width,
            height)) {
      return false;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t next_x = voxels[member].x + g_object_dx[object];
      const int32_t next_y = voxels[member].y + g_object_dy[object];
      const int32_t next_z = voxels[member].z + g_object_dz[object];
      if (!IsInsideRoom(next_x, next_y, width, height)) return false;
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, next_z, width, height);
      if (occupant < 0 || g_voxel_object[occupant] == object) continue;
      if (occupant == player_index) {
        if (player_moves_horizontally) continue;
        return false;
      }
      const int32_t other = g_voxel_object[occupant];
      if (other >= 0 && g_mandatory_objects[other] != 0 &&
          ObjectProposalVacatesCell(
              voxels, other, next_x, next_y, next_z)) {
        continue;
      }
      if (other >= 0 && g_object_falling[other] != 0 &&
          g_moving_objects[other] == 0 &&
          !FallingObjectRefillsCell(
              voxels, next_x, next_y, next_z, width, height)) {
        continue;
      }
      return false;
    }
  }

  // Two independent bodies may not claim the same destination.
  for (int32_t first = 0; first < g_object_count; ++first) {
    if (g_mandatory_objects[first] == 0) continue;
    for (int32_t second = first + 1; second < g_object_count; ++second) {
      if (g_mandatory_objects[second] == 0) continue;
      for (int32_t first_member = g_object_head[first]; first_member >= 0;
           first_member = g_next_object_voxel[first_member]) {
        for (int32_t second_member = g_object_head[second]; second_member >= 0;
             second_member = g_next_object_voxel[second_member]) {
          if (voxels[first_member].x + g_object_dx[first] ==
                  voxels[second_member].x + g_object_dx[second] &&
              voxels[first_member].y + g_object_dy[first] ==
                  voxels[second_member].y + g_object_dy[second] &&
              voxels[first_member].z + g_object_dz[first] ==
                  voxels[second_member].z + g_object_dz[second]) {
            return false;
          }
        }
      }
    }
  }

  int32_t representative_dx = 0;
  int32_t representative_dy = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    representative_dx = g_object_dx[object];
    representative_dy = g_object_dy[object];
    break;
  }

  // If a turning body slides sideways out from under a stationary stack, the
  // unsupported stack's downward proposal belongs to this same synchronized
  // tick. Propagate support loss upward before the gravity resolver so every
  // member of the stack descends one cell while its former carrier departs.
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_component_objects[object] = 0;
  }
  bool support_loss_changed = true;
  while (support_loss_changed) {
    support_loss_changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] != 0 ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      const int32_t synchronized_carrier = g_carrier_parent[object];
      if (synchronized_carrier >= 0 &&
          g_mandatory_objects[synchronized_carrier] != 0 &&
          g_object_dx[object] == g_object_dx[synchronized_carrier] &&
          g_object_dy[object] == g_object_dy[synchronized_carrier] &&
          g_object_dz[object] == g_object_dz[synchronized_carrier]) {
        // The carrier vacates the old support cell but refills the rider's
        // translated support cell with the same rigid transform.
        continue;
      }
      bool had_departing_support = false;
      bool has_stable_support = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object == object) continue;
        if (support_object >= 0 && g_mandatory_objects[support_object] != 0 &&
            ObjectProposalVacatesCell(
                voxels,
                support_object,
                voxel.x,
                voxel.y,
                voxel.z - 1)) {
          if (g_mandatory_objects[object] != 0 &&
              g_object_dx[object] == g_object_dx[support_object] &&
              g_object_dy[object] == g_object_dy[support_object] &&
              g_object_dz[object] == g_object_dz[support_object]) {
            // Both bodies apply the same transform, so the support remains
            // directly beneath the rider at the destination even if the
            // carrier-parent marker was cleared after momentum resolution.
            has_stable_support = true;
            break;
          }
          had_departing_support = true;
          continue;
        }
        if (support_object >= 0 &&
            g_component_objects[support_object] != 0) {
          had_departing_support = true;
          continue;
        }
        has_stable_support = true;
        break;
      }
      if (had_departing_support && !has_stable_support) {
        // A horizontal proposal cannot remain suspended above a support
        // component that is falling during this same tick. Gravity wins for
        // the rider too, so a whole vertical stack descends together instead
        // of its upper member skating sideways through the air.
        g_mandatory_objects[object] = 0;
        g_moving_objects[object] = 0;
        g_component_objects[object] = 1;
        g_object_falling[object] = 1;
        support_loss_changed = true;
      }
    }
  }
  AdvanceUnmovedGravityOneStep(
      voxels,
      count,
      width,
      height,
      player_index,
      representative_dx,
      representative_dy,
      player_moves_horizontally,
      true);

  // A body can enter the space immediately above a source cell another body
  // vacates in this tick. It inherits that departing support's direction on
  // the next tick instead of falling or retaining an unrelated ramp heading.
  // Capture the relation while the spatial index still represents all source
  // coordinates; the translation commit below then moves both bodies.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t target_x = voxels[member].x + g_object_dx[object];
      const int32_t target_y = voxels[member].y + g_object_dy[object];
      const int32_t target_z = voxels[member].z + g_object_dz[object];
      if (target_z == INT32_MIN) continue;
      const int32_t departing_support = FindVoxelAt(
          voxels, target_x, target_y, target_z - 1, width, height);
      const int32_t support_object = departing_support >= 0
          ? g_voxel_object[departing_support]
          : -1;
      if (support_object < 0 || support_object == object ||
          g_mandatory_objects[support_object] == 0 ||
          !ObjectProposalVacatesCell(
              voxels,
              support_object,
              target_x,
              target_y,
              target_z - 1)) {
        continue;
      }
      g_inherited_support_motion[object] = static_cast<uint8_t>(
          g_object_direction[support_object] + 1);
      break;
    }
  }

  bool moved = false;
  TranslateHiddenOrangeWallsWithProposals(
      voxels, count, false, 0, 0, 0, false);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    moved = true;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += g_object_dx[object];
      voxels[member].y += g_object_dy[object];
      voxels[member].z += g_object_dz[object];
    }
    if (g_inherited_support_motion[object] != 0) {
      g_object_direction[object] = static_cast<uint8_t>(
          g_inherited_support_motion[object] - 1);
    }
  }
  if (!moved) {
    // A latent-momentum body may have advanced only along gravity and landed
    // on a lower slope. Report that synchronized movement to the caller so it
    // can promote the saved direction back to active Ice momentum instead of
    // completing the command on the landing frame.
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_fell_objects[object] != 0) return true;
    }
    return false;
  }
  ArmTranslatedFloatingFloors(voxels);
  BuildSpatialIndex(voxels, count, width, height);
  PreserveSlopeCarriedMomentum(voxels, width, height);
  PreserveMovableSlopeRiderMomentum(voxels, width, height);
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_redirected[object] == 2) {
      // The lifted body moved vertically because its horizontal proposal was
      // blocked. It must not inherit the ramp body's horizontal command as a
      // new Ice-momentum tick.
      g_moving_objects[object] = 0;
      bool lifted_body_is_movable_ramp = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        lifted_body_is_movable_ramp |=
            IsBlueBoxSlopeRole(voxels[member].role) ||
            IsYellowCloneSlopeRole(voxels[member].role);
      }
      if (lifted_body_is_movable_ramp &&
          !DeferredSlopeProposalIsClear(
              voxels, object, player_index, width, height)) {
        g_mandatory_objects[object] = 0;
      }
      g_object_redirected[object] = 0;
    }
  }
  // A lifted ramp stack may leave several members marked mandatory even
  // though only the exposed top member has a clear downhill continuation.
  // Prune each blocked ramp now so one stale proposal cannot cancel an
  // otherwise independent free ramp on the following tick.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 &&
        g_inherited_support_motion[object] == 0) {
      continue;
    }
    bool object_is_movable_ramp = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      object_is_movable_ramp |=
          IsBlueBoxSlopeRole(voxels[member].role) ||
          IsYellowCloneSlopeRole(voxels[member].role);
    }
    if (object_is_movable_ramp &&
        !DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height)) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      g_inherited_support_motion[object] = 0;
    }
  }
  return true;
}

bool VoxelWillLandOnSlope(
    Voxel* voxels,
    int32_t count,
    const Voxel& voxel,
    int32_t ignored_object,
    int32_t width) {
  const int32_t support = FindNearestVoxelBelow(
      voxels, count, voxel.x, voxel.y, voxel.z, ignored_object, width);
  return support >= 0 && IsIceSlopeRole(voxels[support].role);
}

bool MovingObjectWillLandOnSlope(
    Voxel* voxels,
    int32_t count,
    int32_t width) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
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

void SettleAllObjects(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = 1;
  }
  SettleFlaggedObjects(voxels, count, width, height);
}

bool ObjectsNeedGravityTick(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    bool rebuild_spatial_index = true) {
  // Carrier rejection can restore a body after an earlier translation built
  // the index. Rebuild here so the final quiescence decision never observes a
  // ghost support at a body's former coordinate.
  if (rebuild_spatial_index) {
    BuildSpatialIndex(voxels, count, width, height);
  }
  bool needs_tick = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (!ObjectIsActive(voxels, object, width, height)) continue;
    if (ObjectIsFloatingFloor(voxels, object) &&
        g_object_gravity_armed[object] == 0) {
      continue;
    }
    // A vertically interlocked component can give every member apparent
    // direct support even while the entire component is falling. The settle
    // pass owns the decision to clear this flag when the component lands.
    if (g_object_gravity_armed[object] != 0 &&
        g_object_falling[object] != 0) {
      if (ObjectHasStableDirectSupport(
              voxels, object, width, height)) {
        g_object_falling[object] = 0;
        continue;
      }
      needs_tick = true;
      continue;
    }
    if (ObjectHasDirectSupport(voxels, object, width, height)) {
      g_object_falling[object] = 0;
      g_object_gravity_armed[object] = 1;
      continue;
    }
    // A command is not quiescent while an active body is unsupported. This
    // also catches a carried body that was rejected after its support moved:
    // it must begin falling in the current command, not remain suspended until
    // the next input happens to initialize gravity again.
    g_object_gravity_armed[object] = 1;
    g_object_falling[object] = 1;
    needs_tick = true;
  }
  return needs_tick;
}

bool ObjectsAdvancedThisTick() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_fell_objects[object] != 0) return true;
  }
  return false;
}
