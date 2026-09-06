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

bool CanPushSlopeContactChain(
    Voxel* voxels, int32_t object, int32_t direction,
    int32_t width, int32_t height);

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
    if (CanPushSlopeContactChain(
            voxels, occupant_object, direction, width, height)) {
      // Crest momentum pushes eligible cargo instead of reflecting.
      // This query checks every member before the ordinary transaction commits.
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
    int32_t height,
    bool has_ice_momentum) {
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
  // Once on the ramp surface, ordinary directions remain legal. From level
  // terrain, walking can enter only through the high edge. Existing Ice
  // momentum may also cross a side edge at the same elevation; the following
  // tick redirects downhill. Standing on Ice alone is not sliding momentum.
  if (SlopeSupportingVoxel(voxels, voxel, width, height) >= 0) return false;
  const int32_t slope_direction = IceSlopeDirection(voxels[next_support].role);
  return direction != OppositeDirection(slope_direction) &&
      !(has_ice_momentum && direction != slope_direction);
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
