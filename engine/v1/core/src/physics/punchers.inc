struct PuncherContact {
  bool player = false;
  bool object = false;
  int32_t player_direction = -1;
};

int32_t PuncherDirection(const Voxel& puncher) {
  return puncher.role == kPuncherRole && puncher.generic_id >= 0
      ? (puncher.generic_id / 2) & 3
      : -1;
}

bool PuncherIsSprung(const Voxel& puncher) {
  return puncher.role == kPuncherRole &&
      (puncher.generic_id & 1) != 0;
}

bool ResetSprungPunchers(Voxel* voxels) {
  bool changed = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] != kMechanismObject) continue;
    const int32_t index = g_object_head[object];
    if (!PuncherIsSprung(voxels[index])) continue;
    --voxels[index].generic_id;
    changed = true;
  }
  return changed;
}

bool ObjectCanBePunched(int32_t object) {
  if (object < 0) return false;
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

PuncherContact FindPuncherContacts(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool include_sprung) {
  PuncherContact contact;
  const int32_t player_object = player_index >= 0
      ? g_voxel_object[player_index]
      : -1;
  // Mechanisms retain source order, including overlapping punchers. Skip
  // immutable terrain rather than rescanning every voxel on every tick.
  for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
    if (g_object_kind[fixture] != kMechanismObject) continue;
    const int32_t puncher_index = g_object_head[fixture];
    const Voxel& puncher = voxels[puncher_index];
    const int32_t punch_direction = PuncherDirection(puncher);
    if (punch_direction < 0 ||
        (!include_sprung && PuncherIsSprung(puncher)) ||
        !IsInsideRoom(puncher.x, puncher.y, width, height)) {
      continue;
    }
    if (player_index >= 0 && player_object < 0) {
      const Voxel& player = voxels[player_index];
      if (player.x == puncher.x && player.y == puncher.y &&
          player.z == puncher.z) {
        contact.player = true;
        if (contact.player_direction < 0) {
          contact.player_direction = punch_direction;
        }
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectCanBePunched(object) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].x == puncher.x &&
            voxels[member].y == puncher.y &&
            voxels[member].z == puncher.z) {
          contact.object = true;
          break;
        }
      }
    }
  }
  return contact;
}

PuncherContact ActivatePunchers(
    MotionState* state,
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  PuncherContact contact;
  const int32_t player_object = player_index >= 0
      ? g_voxel_object[player_index]
      : -1;
  // Mechanisms retain source order, including overlapping punchers. Skip
  // immutable terrain rather than rescanning every voxel on every tick.
  for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
    if (g_object_kind[fixture] != kMechanismObject) continue;
    const int32_t puncher_index = g_object_head[fixture];
    Voxel& puncher = voxels[puncher_index];
    const int32_t punch_direction = PuncherDirection(puncher);
    if (punch_direction < 0 || PuncherIsSprung(puncher) ||
        !IsInsideRoom(puncher.x, puncher.y, width, height)) {
      continue;
    }
    bool triggered = false;
    if (player_index >= 0 && player_object < 0) {
      const Voxel& player = voxels[player_index];
      if (player.x == puncher.x && player.y == puncher.y &&
          player.z == puncher.z) {
        contact.player = true;
        triggered = true;
        if (contact.player_direction < 0) {
          contact.player_direction = punch_direction;
        }
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectCanBePunched(object) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      bool overlaps = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        overlaps |= voxels[member].x == puncher.x &&
            voxels[member].y == puncher.y &&
            voxels[member].z == puncher.z;
      }
      if (!overlaps) continue;
      contact.object = true;
      triggered = true;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        state->horizontal_momentum[member] = static_cast<uint8_t>(
            kPunchMomentumBase + punch_direction);
      }
    }
    if (triggered) ++puncher.generic_id;
  }
  return contact;
}

void SeedMovingObjectsWithPunchMomentum(
    MotionState* state,
    int32_t direction) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->horizontal_momentum[member] = static_cast<uint8_t>(
          kPunchMomentumBase + direction);
    }
  }
}

bool HasPunchObjectMomentum(
    const MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (IsPunchMomentum(ReadObjectMomentum(
            state->horizontal_momentum, object)) &&
        ObjectIsActive(voxels, object, width, height)) {
      return true;
    }
  }
  return false;
}
