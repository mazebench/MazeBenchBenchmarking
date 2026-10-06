#include "voxelbench/physics.hpp"
#include "voxelbench/search.hpp"

#include <algorithm>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <memory>

namespace {

int failures = 0;
int tests_run = 0;
const char* current_test = "";

void Run(void (*test)(), const char* name) {
  current_test = name;
  ++tests_run;
  test();
}

void Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL [" << current_test << "]: " << message << '\n';
    ++failures;
  }
}

uint32_t Role(const char* value) {
  int32_t length = 0;
  while (value[length] != '\0') ++length;
  return voxelbench::hash_role(reinterpret_cast<const uint8_t*>(value), length);
}

struct ObserverTrace {
  int32_t calls = 0;
  int32_t ticks[4]{};
  int32_t goal_x[4]{};
};

void CaptureObserverFrame(
    const voxelbench::Voxel* voxels,
    int32_t count,
    const voxelbench::MotionState* state,
    void* context) {
  ObserverTrace* trace = static_cast<ObserverTrace*>(context);
  if (trace->calls >= 4) return;
  const int32_t frame = trace->calls++;
  trace->ticks[frame] = state->tick;
  trace->goal_x[frame] = -1;
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == Role("goal")) {
      trace->goal_x[frame] = voxels[index].x;
      break;
    }
  }
}

void TestSimplePush() {
  voxelbench::Voxel voxels[] = {
      {2, 2, -7, Role("player"), -1},
      {2, 1, -7, Role("pushable"), -1},
      {2, 2, -8, Role("floor"), -1},
      {2, 1, -8, Role("floor"), -1},
      {2, 0, -8, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 5, 5, 0) == 0, "push command should run");
  Check(voxels[0].x == 2 && voxels[0].y == 1 && voxels[0].z == -7,
        "player should enter the pushed voxel's old cell without changing Z");
  Check(voxels[1].x == 2 && voxels[1].y == 0 && voxels[1].z == -7,
        "pushable should move one cell without changing Z");
}

void TestWrappingPushMovesPlayerSupport() {
  for (const bool remote_slope : {false, true}) {
    for (const bool wrapped : {false, true}) {
      std::vector<voxelbench::Voxel> voxels = {
          {2, 3, 2, Role("player"), -1},
          {2, 3, 1, Role("weightless-pushable"), 53},
          {1, 2, 1, Role("weightless-pushable"), 17},
          {1, 3, 1, Role("weightless-pushable"), 17},
          {1, 4, 1, Role("weightless-pushable"), 17},
          {2, 2, 1, Role("weightless-pushable"), 17},
          {2, 2, 2, Role("weightless-pushable"), 17},
      };
      if (wrapped) voxels.push_back({2, 4, 1, Role("weightless-pushable"), 17});
      const size_t dynamic_count = voxels.size();
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          voxels.push_back({x, y, 0,
              Role(remote_slope && x == 5 && y == 5 ? "ice-slope-up" : "floor"), -1});
        }
      }
      const auto initial = voxels;
      Check(voxelbench::simulate_turn(
                voxels.data(), static_cast<int32_t>(voxels.size()), 6, 6, 0) == 0,
            "wrapping push command should complete");
      for (size_t i = 0; i < voxels.size(); ++i) {
        Check(voxels[i].x == initial[i].x && voxels[i].z == initial[i].z &&
                  voxels[i].y == initial[i].y - (wrapped && i < dynamic_count ? 1 : 0),
              "player and both bodies move together only when the support joins the push");
      }
    }
  }
}

void TestPlayerGateRisesWhenPlayerApproaches() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 3, 1, Role("player-gate"), 0},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 6, 6, 0) ==
            voxelbench::TickResult::kMore,
        "player-gate approach should schedule a mechanism tick");
  Check(voxels[0].y == 4,
        "player should approach a lowered player gate");
  Check(voxels[1].generic_id == 0,
        "player gate should remain lowered in the movement frame");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 6, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "player-gate mechanism tick should complete the command");
  Check(voxels[1].generic_id == 1,
        "player gate should become a raised cube one tick later");
}

void TestPlayerGateBlockedByEveryPushableFamily() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const char* role : {"pushable", "weightless-pushable", "floating-floor"}) {
    voxelbench::Voxel voxels[] = {
        {2, 4, 1, Role("player"), -1},
        {2, 3, 1, Role(role), Role(role) == Role("weightless-pushable") ? 47 : -1},
        {2, 2, 1, Role("player-gate"), 0},
        {2, 0, 0, Role("floor"), -1},
        {2, 1, 0, Role("floor"), -1},
        {2, 2, 0, Role("floor"), -1},
        {2, 3, 0, Role("floor"), -1},
        {2, 4, 0, Role("floor"), -1},
        {2, 5, 0, Role("floor"), -1},
    };
    for (int32_t command = 1; command <= 3; ++command) {
      Check(voxelbench::simulate_command(
                &workspace, &state, voxels, 9, 6, 6, 0) == 0,
            "pushing a body through a lowered gate should run");
      Check(state.tick == (command == 3 ? 2 : 1),
            "an occupied gate must not schedule a spurious raising tick");
      Check(voxels[0].y == 4 - command && voxels[0].z == 1 &&
                voxels[1].y == 3 - command && voxels[1].z == 1 &&
                voxels[1].role == Role(role),
            "the pushable body and player should cross the gate without changing height");
      Check(voxels[2].x == 2 && voxels[2].y == 2 && voxels[2].z == 1 &&
                voxels[2].generic_id == (command == 3 ? 1 : 0),
            "the gate should stay down while occupied, then raise after the player leaves");
    }
  }
}

void TestPlayerIceSlide() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 5, 5, 0) == 0, "ice command should run");
  Check(voxels[0].x == 2 && voxels[0].y == 0,
        "player should cross the Ice strip and stop on normal floor");
}

void TestApproachingIceFromWallDoesNotStartSlidingEarly() {
  voxelbench::Voxel voxels[] = {
      {2, 5, 2, Role("player"), -1},
      {2, 5, 1, Role("solid"), -1},
      {2, 4, 1, Role("solid"), -1},
      {2, 3, 1, Role("ice"), -1},
      {2, 2, 1, Role("ice"), -1},
      {2, 1, 1, Role("ice"), -1},
      {2, 0, 1, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 6, 6, 0) == 0,
        "approaching Ice across a wall top should run");
  Check(voxels[0].y == 4 && voxels[0].z == 2,
        "the command should stop before the player actually enters Ice");
}

void TestSlidingMomentumEntersRampSide() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t side = 0; side < 2; ++side) {
    voxelbench::Voxel voxels[] = {
        {2, 5, 2, Role("player"), -1},
        {2, 5, 1, Role("ice"), -1},
        {2, 4, 1, Role("ice"), -1},
        {2, 3, 1, Role("ice"), -1},
        {2, 2, 1, Role(side == 0 ? "ice-slope-left" : "ice-slope-right"), -1},
        {1, 2, 0, Role("floor"), -1},
        {3, 2, 0, Role("floor"), -1},
    };
    voxelbench::Voxel final_only[7];
    std::memcpy(final_only, voxels, sizeof(voxels));
    const int32_t exit_x = side == 0 ? 3 : 1;
    voxelbench::reset_workspace(&workspace);
    voxelbench::reset_motion_state(&state);
    for (int32_t tick = 1; tick <= 4; ++tick) {
      const auto result = voxelbench::step_tick(
          &workspace, &state, voxels, 7, 6, 6, 0);
      Check(result != voxelbench::TickResult::kInvalid,
            "side-entry slide should advance successfully");
      Check(state.tick == tick &&
                voxels[0].x == (tick < 4 ? 2 : exit_x) &&
                voxels[0].y == (tick < 4 ? 5 - tick : 2) &&
                voxels[0].z == (tick < 4 ? 2 : 1),
            "slide should enter the ramp level, then turn downhill next tick");
    }
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 7, 6, 6, 0) ==
              voxelbench::TickResult::kComplete && state.tick == 4,
          "side-entry slide should finish after exactly four observable ticks");
    Check(voxelbench::simulate_turn(final_only, 7, 6, 6, 0) == 0 &&
              final_only[0].x == exit_x && final_only[0].y == 2 &&
              final_only[0].z == 1,
          "final-state API should agree with the side-entry tick trace");
  }
}

void TestWalkingCannotEnterRampSide() {
  for (int32_t side = 0; side < 2; ++side) {
    for (int32_t icy_support = 0; icy_support < 2; ++icy_support) {
      voxelbench::Voxel voxels[] = {
          {2, 3, 2, Role("player"), -1},
          {2, 3, 1, Role(icy_support ? "ice" : "solid"), -1},
          {2, 2, 1, Role(side == 0 ? "ice-slope-left" : "ice-slope-right"), -1},
          {1, 2, 0, Role("floor"), -1},
          {3, 2, 0, Role("floor"), -1},
      };
      Check(voxelbench::simulate_turn(voxels, 5, 6, 6, 0) == 0 &&
                voxels[0].x == 2 && voxels[0].y == 3 && voxels[0].z == 2,
            "walking onto a ramp side stays blocked even when standing on Ice");
    }
  }
}

void TestRampSideSlideStillCollidesWithSolids() {
  voxelbench::Voxel voxels[] = {
      {2, 5, 2, Role("player"), -1},
      {2, 5, 1, Role("ice"), -1},
      {2, 4, 1, Role("ice"), -1},
      {2, 3, 1, Role("ice"), -1},
      {2, 2, 1, Role("ice-slope-left"), -1},
      {2, 2, 2, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 6, 6, 0) == 0 &&
            voxels[0].x == 2 && voxels[0].y == 3 && voxels[0].z == 2,
        "sliding momentum must not bypass a solid above the destination ramp");
}

void TestRampCrestPushesOnlyUnblockedWeightlessChains() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  // Crossing a 64-bit frontier boundary and reversing object storage exercise
  // both traversal orders and scratch cleanup across successive commands.
  for (const int32_t length : {1, 65}) {
    for (const bool reverse : {false, true}) {
      for (const bool blocked : {false, true}) {
        voxelbench::Voxel voxels[256];
        int32_t count = 0;
        const int32_t height = length + 5;
        voxels[count++] = {0, length + 2, 1, Role("player"), -1};
        for (int32_t index = 0; index < length; ++index) {
          const int32_t y = reverse ? index + 1 : length - index;
          voxels[count++] = {0, y, 2, Role("weightless-pushable"), 1000 + y};
        }
        for (int32_t y = 0; y < height; ++y) {
          voxels[count++] = {0, y, 0, Role("floor"), -1};
        }
        for (int32_t y = 0; y <= length; ++y) {
          voxels[count++] = {0, y, 1, Role("solid"), -1};
        }
        voxels[count++] = {0, length + 1, 1, Role("ice-slope-up"), -1};
        if (blocked) voxels[count++] = {0, 0, 2, Role("solid"), -1};
        Check(voxelbench::simulate_command(
                  &workspace, &state, voxels, count, 1, height, 0) == 0,
              "ramp-crest chain command should complete");
        Check(state.tick == 2 && voxels[0].x == 0 &&
                  voxels[0].y == (blocked ? length + 2 : length) &&
                  voxels[0].z == (blocked ? 1 : 2),
              "the crest should push a clear chain or reflect from a blocked one");
        for (int32_t index = 1; index <= length; ++index) {
          Check(voxels[index].x == 0 && voxels[index].z == 2 &&
                    voxels[index].y == voxels[index].generic_id - 1000 -
                        (blocked ? 0 : 1),
                "crest contact must move the whole chain exactly once or none of it");
        }
      }
    }
  }
}

void TestSparseStackCarryIgnoresUnrelatedSlopes() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const bool remote_slope : {false, true}) {
    for (const bool shares_player : {false, true}) {
      for (const bool slippery_start : {false, true}) {
        voxelbench::Voxel voxels[80];
        int32_t count = 0;
        voxels[count++] = {0, 5, 2, Role("player"), -1};
        for (int32_t x = 0; x < 2; ++x) {
          for (int32_t y = 2; y <= 4; ++y) {
            if (x != 0 || y != 3) {
              voxels[count++] = {x, y, 2, Role("weightless-pushable"), 17};
            }
            voxels[count++] = {x, y, 3, Role("weightless-pushable"), 39};
          }
        }
        if (shares_player) {
          voxels[count++] = {0, 5, 3, Role("weightless-pushable"), 39};
        }
        const int32_t dynamic_count = count;
        for (int32_t x = 0; x < 6; ++x) {
          for (int32_t y = 0; y < 6; ++y) {
            voxels[count++] = {x, y, 0,
                Role(remote_slope && x == 5 && y == 5
                    ? "ice-slope-up" : "floor"), -1};
          }
        }
        for (int32_t x = 0; x < 2; ++x) {
          for (int32_t y = 1; y <= 4; ++y) {
            voxels[count++] = {x, y, 1,
                Role(slippery_start && y >= 2 ? "ice" : "solid"), -1};
          }
        }
        voxels[count++] = {0, 5, 1, Role("solid"), -1};
        voxelbench::Voxel before[80];
        std::memcpy(before, voxels, sizeof(voxelbench::Voxel) *
            static_cast<size_t>(count));
        Check(voxelbench::simulate_command(
                  &workspace, &state, voxels, count, 6, 6, 0) == 0 &&
                  state.tick == 1,
              "a sparse carried stack should stop with its grounded carrier");
        for (int32_t index = 0; index < count; ++index) {
          Check(voxels[index].x == before[index].x &&
                    voxels[index].z == before[index].z &&
                    voxels[index].y == before[index].y -
                        (index < dynamic_count ? 1 : 0),
                "the shared player/box support should carry every rider cell once");
        }
      }
    }
  }
}

void TestInterlockedPushDoesNotInventMomentum() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  const char* ramp_roles[] = {"solid", "ice-slope-up", "ice-slope-right",
                              "ice-slope-down", "ice-slope-left"};
  for (const char* ramp_role : ramp_roles) {
    for (const bool blocked : {false, true}) {
      for (const bool reverse_order : {false, true}) {
        std::vector<voxelbench::Voxel> voxels;
        for (int32_t x = 0; x < 8; ++x) {
          for (int32_t y = 0; y < 10; ++y) {
            voxels.push_back({x, y, 0, Role("floor"), -1});
          }
        }
        for (int32_t x = 1; x <= 3; ++x) {
          for (int32_t y = 2; y <= 4; ++y) {
            voxels.push_back({x, y, 1, Role("solid"), -1});
            for (int32_t z = 2; z <= 4; ++z) {
              if (y != 3 || z != 3) {
                voxels.push_back({x, y, z, Role("weightless-pushable"), 17});
              }
            }
          }
        }
        for (int32_t x = 1; x <= 5; ++x) {
          voxels.push_back({x, 3, 3, Role("weightless-pushable"), 39});
        }
        voxels.push_back({5, 3, 1, Role("solid"), -1});
        voxels.push_back({5, 4, 1, Role("solid"), -1});
        voxels.push_back({5, 3, 2, Role("weightless-pushable"), 39});
        voxels.push_back({5, 4, 2, Role("player"), -1});
        voxels.push_back({2, 3, 5, Role("weightless-pushable"), 91});
        voxels.push_back({7, 9, 1, Role(ramp_role), -1});
        if (blocked) voxels.push_back({1, 1, 4, Role("solid"), -1});
        if (reverse_order) std::reverse(voxels.begin(), voxels.end());
        const auto before = voxels;
        const int32_t count = static_cast<int32_t>(voxels.size());
        // Reuse the same workspace across changing object orders and scenes.
        Check(voxelbench::simulate_command(&workspace, &state, voxels.data(),
                  count, 8, 10, 0) == 0 && state.tick == 1,
              "interlocked bodies must finish their ordinary push in one tick");
        for (size_t i = 0; i < voxels.size(); ++i) {
          const bool dynamic = before[i].role == Role("player") ||
              before[i].role == Role("weightless-pushable");
          Check(voxels[i].x == before[i].x && voxels[i].z == before[i].z &&
                    voxels[i].y == before[i].y - (dynamic && !blocked ? 1 : 0),
                "a remote ramp cannot add translation or make the stack fall");
        }
      }
    }
  }
}

void TestCarrierMomentumCannotLeakIntoNextScene() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  voxelbench::Voxel stack[] = {
      {2, 5, 1, Role("player"), -1},
      {2, 4, 1, Role("weightless-pushable"), 17},
      {2, 4, 2, Role("weightless-pushable"), 39},
      {2, 5, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("floor"), -1},
      {5, 5, 0, Role("ice-slope-up"), -1},
  };
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(&workspace, &state, stack, 9, 6, 6, 0) ==
            voxelbench::TickResult::kMore && stack[2].y == 3,
        "the first scene should leave a carried Ice impulse in its workspace");
  voxelbench::Voxel next[] = {
      {0, 5, 1, Role("player"), -1},
      {2, 5, 1, Role("clone"), 0},
      {3, 5, 1, Role("clone"), 1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 5, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {3, 5, 0, Role("floor"), -1},
      {3, 4, 0, Role("floor"), -1},
      {3, 3, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_command(
            &workspace, &state, next, 10, 6, 6, 0) == 0 && state.tick == 1,
        "reusing an interrupted workspace must not give a new clone momentum");
  Check(next[0].y == 4 && next[1].y == 4 && next[2].y == 4,
        "all actors in the replacement scene should take only their one command step");
}

void TestBlockedPassengersDoNotAnchorTheirCarrier() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const bool remote_slope : {false, true}) {
    for (const bool loses_support : {false, true}) {
      for (const bool stacked : {false, true}) {
        voxelbench::Voxel voxels[80];
        int32_t count = 0;
        voxels[count++] = {2, 4, 1, Role("player"), -1};
        const int32_t rider_y = loses_support ? 3 : 2;
        voxels[count++] = {2, rider_y, 4, Role("weightless-pushable"), 39};
        if (stacked) {
          voxels[count++] = {2, rider_y, 5, Role("weightless-pushable"), 63};
        }
        const int32_t carrier_begin = count;
        for (int32_t x = 1; x <= 2; ++x) {
          for (int32_t y = 2; y <= 3; ++y) {
            for (int32_t z = 1; z <= 3; ++z) {
              voxels[count++] = {x, y, z, Role("weightless-pushable"), 17};
            }
          }
        }
        const int32_t terrain_begin = count;
        voxels[count++] = {2, rider_y - 1, 4, Role("solid"), -1};
        for (int32_t x = 0; x < 6; ++x) {
          for (int32_t y = 0; y < 6; ++y) {
            voxels[count++] = {x, y, 0,
                Role(remote_slope && x == 5 && y == 5
                    ? "ice-slope-up" : "floor"), -1};
          }
        }
        voxelbench::Voxel before[80];
        std::memcpy(before, voxels, sizeof(voxelbench::Voxel) *
            static_cast<size_t>(count));
        voxelbench::reset_motion_state(&state);
        const int32_t expected_ticks = loses_support ? 3 : 1;
        bool complete = false;
        for (int32_t call = 0; call < 8; ++call) {
          const auto result = voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0);
          Check(result == voxelbench::TickResult::kMore ||
                    result == voxelbench::TickResult::kComplete,
                "blocked-passenger command should be valid");
          Check(state.tick >= 1 && state.tick <= expected_ticks,
                "the carrier push must precede exactly two falling ticks");
          const int32_t fall = loses_support ? state.tick - 1 : 0;
          for (int32_t index = 0; index < count; ++index) {
            const bool rider = index >= 1 && index < carrier_begin;
            const bool moves = index == 0 ||
                (index >= carrier_begin && index < terrain_begin);
            Check(voxels[index].x == before[index].x &&
                      voxels[index].y == before[index].y - (moves ? 1 : 0) &&
                      voxels[index].z == before[index].z - (rider ? fall : 0) &&
                      voxels[index].role == before[index].role &&
                      voxels[index].generic_id == before[index].generic_id,
                  "each frame must preserve the blocked passenger stack and terrain");
          }
          if (result == voxelbench::TickResult::kComplete) {
            complete = true;
            break;
          }
        }
        Check(complete && state.tick == expected_ticks,
              "blocked passengers should settle in the authored number of ticks");
      }
    }
  }
}

void TestPushableIceSlide() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 3, 1, Role("pushable"), 17},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 5, 5, 0) == 0,
        "push onto Ice command should run");
  Check(voxels[0].y == 3, "player should enter the object's vacated cell");
  Check(voxels[1].y == 0 && voxels[1].generic_id == 17,
        "pushed object should slide off Ice while preserving its generic ID");
}

void TestPlayerAndPushedBodySlideTogetherOnIce() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 3, 1, Role("weightless-pushable"), 0},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "pushing from Floor onto Ice should retain object momentum");
  Check(state.tick == 1 && voxels[0].y == 3 && voxels[1].y == 2,
        "the initial push should move the player and body one cell");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "the player and pushed body should keep sliding together");
  Check(state.tick == 2 && voxels[0].y == 2 && voxels[1].y == 1,
        "the second Ice tick should advance both horizontal proposals");
}

void TestIceStopsAtObstacle() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 1, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 5, 5, 0) == 0,
        "blocked Ice command should run");
  Check(voxels[0].y == 2, "player should stop on Ice immediately before an obstacle");
}

void TestUnknownRoleBlocks() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("future-role"), 912},
  };
  Check(voxelbench::simulate_turn(voxels, 2, 5, 5, 0) == 0,
        "unknown role command should run");
  Check(voxels[0].y == 2 && voxels[1].generic_id == 912,
        "unknown roles should block and preserve generic IDs");
}

void TestIndependentCloneCommands() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("clone"), 0},
      {2, 2, 1, Role("clone"), 1},
      {1, 1, 1, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 3, 0) == 0,
        "clone command should run");
  Check(voxels[0].y == 1,
        "the player should move independently of a blocked clone");
  Check(voxels[1].y == 2,
        "a clone blocked by terrain should remain stationary");
  Check(voxels[2].y == 1,
        "an unblocked clone should still receive the shared command");
}

void TestBlueSlopeAndBoxShareTheirGenericBody() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 7},
      {2, 2, 1, Role("blue-box-slope-left"), 7},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 4, 4, 0) == 0,
        "a same-ID blue cube and slope push should run");
  Check(voxels[0].y == 2 && voxels[1].y == 1 && voxels[2].y == 1,
        "a blue slope should translate as one rigid body with its same-ID box");

  voxelbench::Voxel blocked[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 7},
      {2, 2, 1, Role("blue-box-slope-left"), 7},
      {2, 1, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(blocked, 9, 4, 4, 0) == 0,
        "a blocked same-ID blue cube and slope push should run");
  Check(blocked[0].y == 3 && blocked[1].y == 2 && blocked[2].y == 2,
        "blocking any blue slope voxel should block its complete same-ID body");
}

void TestYellowSlopeAndCloneShareTheirGenericBody() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("clone"), 4},
      {2, 2, 1, Role("yellow-clone-slope-right"), 4},
      {1, 1, 1, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 3, 0) == 0,
        "a same-ID clone cube and yellow slope command should run");
  Check(voxels[1].y == 2 && voxels[2].y == 2,
        "blocking a clone cube should also block its same-ID yellow slope");

  voxelbench::Voxel pushing[] = {
      {0, 5, 1, Role("player"), -1},
      {2, 4, 1, Role("yellow-clone-slope-down"), 0},
      {2, 3, 1, Role("weightless-pushable"), 0},
      {2, 1, 1, Role("wall"), -1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(pushing, 10, 6, 6, 0) == 0,
        "a yellow clone slope pushing a weightless body should run");
  Check(pushing[0].y == 4 && pushing[1].y == 3 && pushing[2].y == 2,
        "a yellow clone slope should push weightless bodies like a cube clone");
}

void TestInterlockingCloneCommandComponent() {
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {1, 1, 1, Role("clone"), 0},
      {1, 3, 1, Role("clone"), 0},
      {1, 2, 1, Role("clone"), 1},
      {1, 4, 1, Role("clone"), 1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 12, 3, 6, 0) == 0,
        "interlocking clone command should run");
  Check(voxels[1].y == 0 && voxels[2].y == 2 &&
        voxels[3].y == 1 && voxels[4].y == 3,
        "destination-linked clone polycubes should translate atomically");
}

void TestExactSearchTracksCloneActors() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {2, 2, 1, Role("clone"), 0},
      {0, 1, 1, Role("wall"), -1},
      {2, 1, 1, Role("goal"), -1},
      {0, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 1 && result.solution_length == 1 &&
            result.solution[0] == 0,
        "exact search should encode clone motion and let a clone collect a gem");
}

void TestPlayerPolycubeMovesAndFallsRigidly() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player"), -1},
      {1, 2, 2, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
  };
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::MotionState state{};
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a player polycube should move into an unsupported destination");
  Check(voxels[0].y == 1 && voxels[1].y == 1 && voxels[2].y == 1,
        "every player voxel should translate atomically");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 6, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the complete player polycube should fall one row per tick");
  }
  Check(voxels[0].z == -2 && voxels[1].z == -2 && voxels[2].z == -1,
        "player-polycube gravity should preserve every relative offset");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player polycube should disappear once its top passes the room");
  Check(voxels[0].x == -1 && voxels[1].x == -1 && voxels[2].x == -1,
        "abyss removal should remove the complete player polycube together");
}

void TestExactSearchTracksPlayerPolycube() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("goal"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 1 && result.solution_length == 1 &&
            result.solution[0] == 0,
        "exact search should encode every player-polycube voxel as one actor");
}

void TestEveryBoundary() {
  constexpr int32_t positions[][3] = {{2, 0, 0}, {4, 2, 1}, {2, 4, 2}, {0, 2, 3}};
  for (const auto& value : positions) {
    voxelbench::Voxel voxels[] = {
        {value[0], value[1], 1, Role("player"), -1},
        {value[0], value[1], 0, Role("floor"), -1},
    };
    Check(voxelbench::simulate_turn(voxels, 2, 5, 5, value[2]) == 0,
          "boundary command should run");
    Check(voxels[0].x == value[0] && voxels[0].y == value[1],
          "room boundary should stop movement");
  }
}

void TestTickTraceAndWorkspaceIsolation() {
  static voxelbench::PhysicsWorkspace first_workspace;
  static voxelbench::PhysicsWorkspace second_workspace;
  static voxelbench::MotionState first_state;
  static voxelbench::MotionState second_state;
  voxelbench::Voxel first[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  voxelbench::Voxel second[] = {
      {1, 2, -3, Role("player"), -1},
      {1, 2, -4, Role("floor"), -1},
      {2, 2, -4, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&first_workspace);
  voxelbench::reset_workspace(&second_workspace);
  voxelbench::reset_motion_state(&first_state);
  voxelbench::reset_motion_state(&second_state);

  Check(voxelbench::step_tick(
            &first_workspace, &first_state, first, 6, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "the first Ice tick should leave horizontal momentum");
  Check(first_state.tick == 1 && first[0].y == 3,
        "step_tick should advance exactly one Ice cell");
  Check(voxelbench::step_tick(
            &second_workspace, &second_state, second, 3, 5, 5, 1) ==
            voxelbench::TickResult::kComplete,
        "an independent workspace should complete its own command");
  Check(second_state.tick == 1 && second[0].x == 2 && second[0].y == 2,
        "the second workspace should not inherit the first command");

  while (voxelbench::step_tick(
             &first_workspace, &first_state, first, 6, 5, 5, 0) ==
         voxelbench::TickResult::kMore) {
  }
  Check(first_state.tick == 4 && first[0].y == 0,
        "the resumed Ice trace should contain four committed ticks");
  Check(first_state.version == voxelbench::kMotionStateVersion,
        "motion state should carry its serializable format version");
}

void TestObserverReceivesNoMovementCompletionFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("ice"), -1},
      {1, 1, 0, Role("ice"), -1},
      {1, 1, 1, Role("wall"), -1},
      {1, 2, 1, Role("goal"), -1},
  };
  ObserverTrace trace;
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_command(
            &workspace,
            &state,
            voxels,
            6,
            4,
            4,
            0,
            CaptureObserverFrame,
            &trace) == 0,
        "a blocked Ice completion should simulate successfully");
  Check(trace.calls == 2 && trace.ticks[0] == 1 && trace.ticks[1] == 1,
        "the observer should receive both the movement and no-movement final frame");
  Check(trace.goal_x[0] == 1 && trace.goal_x[1] < 0,
        "the final observer frame must include end-of-command gem collection");
}

void TestPreparedMotionStateClearsImmutableSuffix() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 3, 3, 3, 1),
        "the motion-state fixture should prepare its dynamic prefix");
  for (int32_t index = 0; index < 3; ++index) {
    state.horizontal_momentum[index] = 0xff;
    state.falling[index] = 0xff;
    state.gravity_armed[index] = 0xff;
  }
  Check(voxelbench::simulate_command(
            &workspace, &state, voxels, 3, 3, 3, 0) == 0,
        "the prepared motion-state command should complete");
  bool suffix_is_clear = true;
  for (int32_t index = 1; index < 3; ++index) {
    suffix_is_clear = suffix_is_clear &&
        state.horizontal_momentum[index] == 0 &&
        state.falling[index] == 0 && state.gravity_armed[index] == 0;
  }
  Check(suffix_is_clear,
        "serialized motion flags for immutable prepared voxels must be deterministic");
}

void TestPreparedSceneRejectsMovableStaticSuffix() {
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(!voxelbench::prepare_scene(&workspace, voxels, 3, 4, 4, 1),
        "prepared scenes must reject movable voxels in the immutable suffix");
}

void TestPreparedIndexesDoNotLeakToDifferentSceneShape() {
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::Voxel voxels[18];
  int32_t count = 0;
  voxels[count++] = {2, 3, 1, Role("player"), -1};
  voxels[count++] = {2, 3, 0, Role("floor"), -1};
  voxels[count++] = {2, 2, 0, Role("floor"), -1};
  for (int32_t y = 0; y < 5 && count < 17; ++y) {
    for (int32_t x = 0; x < 5 && count < 17; ++x) {
      if ((x == 2 && y == 3) || (x == 2 && y == 2)) continue;
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[17] = {2, 2, 1, Role("solid"), -1};
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 18, 5, 5, 1),
        "the full scene should prepare successfully");
  Check(voxelbench::simulate_turn(&workspace, voxels, 17, 5, 5, 0) == 0,
        "a differently sized scene using the same buffer should run normally");
  Check(voxels[0].x == 2 && voxels[0].y == 2,
        "an excluded stale wall must not remain in the prepared spatial index");
}

void TestInvalidQuiescentCallDoesNotLeakItsAssumption() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 3, 4, 4, 1),
        "the floating-player scene should prepare successfully");
  Check(voxelbench::simulate_quiescent_turn(
            &workspace, voxels, 3, 4, 4, 9) == -1,
        "an invalid quiescent command should be rejected");
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the next ordinary command should begin by settling the player");
  Check(voxels[0].x == 1 && voxels[0].y == 2 && voxels[0].z == 1,
        "an invalid quiescent call must not skip initial gravity later");
}

void TestPlayerGetsVisibleRowZeroVoidFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "walking off Floor should begin a visible void fall");
  Check(state.tick == 1 && voxels[0].x == 1 && voxels[0].y == 0 &&
            voxels[0].z == 1,
        "the first void frame should contain only the horizontal step");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first gravity tick should retain the player on row zero");
  Check(state.tick == 2 && voxels[0].x == 1 && voxels[0].z == 0,
        "the first downward frame should place the player on row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first row below zero should remain a visible tick");
  Check(state.tick == 3 && voxels[0].x == 1 && voxels[0].z == -1,
        "the player should remain visible at row minus one");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the next unsupported fall should complete the command");
  Check(state.tick == 4 && voxels[0].x == -1 && voxels[0].z == -2,
        "the player should disappear after its visible row-minus-one tick");
}

void TestPushableGetsVisibleRowZeroVoidFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a pushable leaving support should continue through gravity ticks");
  Check(state.tick == 1 && voxels[1].x == 1 && voxels[1].y == 0 &&
            voxels[1].z == 1,
        "the pushed body's horizontal tick should not also change Z");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first pushable gravity tick should reach row zero");
  Check(state.tick == 2 && voxels[1].x == 1 && voxels[1].z == 0,
        "the pushed body should remain visible on row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the unsupported pushable should remain visible below row zero");
  Check(state.tick == 3 && voxels[1].x == 1 && voxels[1].z == -1,
        "the pushed body should have a visible row-minus-one frame");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the pushable should disappear on the following unsupported fall");
  Check(state.tick == 4 && voxels[1].x == -1 && voxels[1].z == -2,
        "the pushed body should disappear after its row-minus-one frame");
}

void TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the tall polycube push should start a gravity trace");
  Check(voxels[1].y == 0 && voxels[1].z == 1 && voxels[2].z == 2,
        "the horizontal polycube tick should preserve both heights");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 5, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the tall polycube should remain visible while any cube reaches row zero");
  }
  Check(voxels[1].x == 1 && voxels[1].z == -2 &&
            voxels[2].x == 1 && voxels[2].z == -1,
        "the whole polycube should still be visible with its top at row minus one");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the tall polycube should disappear on its following unsupported tick");
  Check(voxels[1].x == -1 && voxels[2].x == -1,
        "all members of the tall polycube should disappear together");
}

void TestPolycubeAbyssUsesLowestOtherWorldGeometry() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 2, -5, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the deep-world polycube push should start a gravity trace");
  for (int32_t tick = 0; tick < 8; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 6, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "negative world geometry should extend the visible abyss trace");
  }
  Check(voxels[1].x == 1 && voxels[1].z == -7 &&
            voxels[2].x == 1 && voxels[2].z == -6,
        "the polycube should remain visible after its top passes row minus five");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the next unsupported fall should remove the deep-world polycube");
  Check(voxels[1].x == -1 && voxels[2].x == -1,
        "the deep-world polycube should disappear as one rigid body");
}

void TestPlayerAbyssUsesLowestOtherWorldGeometry() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 1, -3, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "walking into a deep world void should start a gravity trace");
  for (int32_t tick = 0; tick < 5; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 3, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the player should remain visible through the world's lowest row");
  }
  Check(voxels[0].x == 1 && voxels[0].z == -4,
        "the player should have a visible frame below row minus three");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player should disappear on the following unsupported fall");
  Check(voxels[0].x == -1 && voxels[0].z == -5,
        "the player should be removed below all other world geometry");
}

void TestFallingRiderDoesNotExtendItsCarriersAbyss() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "pushing a ridden polycube off support should start its fall");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 5, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "a ridden polycube should retain its visible void frames");
  }
  Check(voxels[0].x == 1 && voxels[0].z == -1 && voxels[3].z == -1,
        "the player and carrier should descend together below row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the falling rider must not keep its carrier alive forever");
  Check(voxels[0].x < 0 && voxels[1].x < 0 && voxels[2].x < 0 &&
            voxels[3].x < 0,
        "the rider and its carrier should leave the room together");
}

void TestObjectAboveDescendingPlayerFallsInSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 0, Role("ice"), -1},
      {1, 0, -1, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the player and its passenger should first move horizontally together");
  Check(voxels[0].y == 0 && voxels[0].z == 1 &&
            voxels[1].y == 0 && voxels[1].z == 2,
        "horizontal passenger motion should not also change height");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player and its passenger should complete one synchronized fall");
  Check(voxels[0].z == 0 && voxels[1].z == 1,
        "the passenger should fall with and remain above the player");
}

void TestExactSearchFindsShortestCommands() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved,
        "exact search should solve a supported corridor");
  Check(result.moves == 2 && result.solution_length == 2,
        "exact search should prove the two-command optimum");
  Check(result.solution[0] == 0 && result.solution[1] == 0,
        "exact search should reconstruct both Up commands");
}

void TestFlatIceSearchKeepsExactCommandSemantics() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("floor"), -1},
      {2, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 5, 5, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "flat Ice search should preserve a complete slide as one command");
  Check(result.solution_length == 1 && result.solution[0] == 0,
        "flat Ice search should reconstruct the exact Up slide");
}

void TestGeneralSearchSupportsBoardsWiderThanSixteen() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[22];
  int32_t count = 0;
  for (int32_t x = 0; x < 20; ++x) {
    voxels[count++] = {x, 1, 0, Role("floor"), -1};
  }
  voxels[count++] = {1, 1, 1, Role("player"), -1};
  voxels[count++] = {18, 1, 1, Role("goal"), -1};
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 20, 4, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 17,
        "generalized search should support footprints wider than sixteen cells");
  Check(result.solution_length == 17,
        "wide-board search should reconstruct every exact command");
}

void TestGeneralSearchCollapsesWalkingBeforePushes() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {4, 1, 1, Role("pushable"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {3, 1, 0, Role("floor"), -1},
      {4, 1, 0, Role("floor"), -1},
      {5, 1, 0, Role("floor"), -1},
      {6, 1, 0, Role("floor"), -1},
      {5, 1, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 10, 7, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 4,
        "generalized search should preserve the exact walk-plus-push command cost");
  Check(result.solution_length == 4 && result.solution[0] == 1 &&
            result.solution[1] == 1 && result.solution[2] == 1 &&
            result.solution[3] == 1,
        "generalized search should reconstruct walking commands before both pushes");
  Check(result.expanded <= 3,
        "ordinary corridor walking should not occupy global search nodes");
}

void TestGeneralSearchMatchesMazeBenchEngine3LongRoom() {
  static constexpr const char* kRows[16] = {
      "################",
      "#......#...#...#",
      "#..###.#.#...#.#",
      "#.#..#.#..###..#",
      "#..##..#.#.....#",
      "##.##.#..#.##..#",
      "##..#..#.#..#..#",
      "#.#..#.#..#.@CC#",
      "#...#...#.A##C.#",
      "#..##..##AA..#.#",
      "#.##..#..AA..#.#",
      "#..##...#......#",
      "#..#####.#.B...#",
      "##..###...#BBB.#",
      "###.....#..BX..#",
      "################",
  };
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[512];
  int32_t count = 0;
  for (int32_t y = 0; y < 16; ++y) {
    for (int32_t x = 0; x < 16; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      const char cell = kRows[y][x];
      if (cell == '#') {
        voxels[count++] = {x, y, 1, Role("solid"), -1};
      } else if (cell == '@') {
        voxels[count++] = {x, y, 1, Role("player"), -1};
      } else if (cell == 'X') {
        voxels[count++] = {x, y, 1, Role("goal"), -1};
      } else if (cell >= 'A' && cell <= 'Z') {
        voxels[count++] = {
            x, y, 1, Role("weightless-pushable"), cell - 'A'};
      }
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 16, 16, 50000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 317,
        "generalized exact search should retain MazeBenchEngine3's 317-command optimum");
  Check(result.expanded < 1000,
        "collapsed local reachability should avoid global footstep-state explosion");
}

void TestSearchInitializesFreshWorkspace() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  std::unique_ptr<voxelbench::SearchWorkspace> search_workspace(
      new voxelbench::SearchWorkspace);
  std::memset(
      search_workspace->storage, 0x5a, sizeof(search_workspace->storage));
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      search_workspace.get(), &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 2,
        "a freshly constructed search workspace must initialize its hash stamps");
}

void TestSearchPrunesPlayerGameOverBranches() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 0, 1, Role("goal"), -1},
      {2, 2, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 4, 3, 3, 100);
  Check(result.status == voxelbench::SearchStatus::kUnsolved,
        "a room whose commands all kill the player should be unsolved");
  Check(result.expanded == 1 && result.generated == 0,
        "player disappearance must be pruned before dead states are inserted");
}

void TestPlayerCollectsGemOnlyAtCommandEnd() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 1, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "walking into a gem should complete normally");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the gem must not block the player");
  Check(voxels[3].x < 0,
        "the gem should disappear when the player ends the command on it");
}

void TestBoxMayOverlapGemWithoutCollectingIt() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 0) == 0,
        "a box should be pushable into a gem");
  Check(voxels[1].x == 1 && voxels[1].y == 0 && voxels[1].z == 1,
        "the box should overlap the non-rigid gem");
  Check(voxels[5].x == 1 && voxels[5].y == 0,
        "a box must not collect the gem");
}

void TestSlidingAcrossGemDoesNotCollectIt() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("ice"), -1},
      {1, 1, 0, Role("ice"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 2, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 4, 4, 0) == 0,
        "sliding through a gem should complete normally");
  Check(voxels[0].y == 0,
        "the player should continue past a gem encountered mid-command");
  Check(voxels[5].x == 1 && voxels[5].y == 2,
        "a gem crossed before command end must remain collectible");
}

void TestPlayerSettlesBeforeHorizontalInput() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 3, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a suspended player should begin settling before input");
  Check(state.tick == 1 && voxels[0].y == 2 && voxels[0].z == 2,
        "the first pre-command tick should contain gravity only");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the player should finish settling before the command runs");
  Check(state.tick == 2 && voxels[0].y == 2 && voxels[0].z == 1,
        "the player should land without horizontal displacement");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the requested command should run after settling");
  Check(state.tick == 3 && voxels[0].y == 1 && voxels[0].z == 1,
        "horizontal movement should start only from the settled state");
}

void TestPolycubeSettlesAsOneBodyBeforeHorizontalInput() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 1, 3, Role("weightless-pushable"), 4},
      {2, 1, 3, Role("weightless-pushable"), 4},
      {1, 3, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kMore,
        "a suspended polycube should begin settling before input");
  Check(voxels[0].x == 1 && voxels[1].z == 2 && voxels[2].z == 2,
        "the polycube should descend rigidly while the player waits");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kMore,
        "the polycube should land before horizontal input");
  Check(voxels[0].x == 1 && voxels[1].z == 1 && voxels[2].z == 1,
        "all polycube members should land in the same tick");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kComplete,
        "the command should resume once every body is settled");
  Check(voxels[0].x == 2 && voxels[0].y == 3,
        "the player should move only after the polycube lands");
}

void TestSearchRequiresACommandToCollectStartingGem() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 0, 1, Role("player"), -1},
      {0, 0, 0, Role("floor"), -1},
      {0, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 3, 1, 1, 100);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "search should treat the gem as collected only after a command ends");
}

void TestPushCannotWalkPlayerOffWallSupport() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 8},
      {1, 1, 2, Role("weightless-pushable"), 8},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 0) == 0,
        "a blocked wall-supported push should complete normally");
  Check(voxels[0].y == 2 && voxels[0].z == 2 &&
            voxels[1].y == 1 && voxels[2].y == 1,
        "pushing must not let the player walk off a non-Floor support");
}

void TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {0, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 2, Role("weightless-pushable"), 0},
      {0, 1, 1, Role("wall"), -1},
      {2, 1, 1, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "walking beneath a supported weightless body should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the player should enter the empty cell beneath the body");
  Check(voxels[1].y == 1 && voxels[2].y == 1 && voxels[3].y == 1,
        "entering underneath must not acquire or translate the body");
}

void TestPlayerDepartureDoesNotCarryMultiplySupportedBody() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 2, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("weightless-pushable"), 0},
      {2, 2, 2, Role("weightless-pushable"), 0},
      {2, 2, 1, Role("weightless-pushable"), 1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "walking out beneath a multiply supported body should run");
  Check(voxels[0].x == 0 && voxels[0].y == 1,
        "the player should leave its old support position");
  Check(voxels[1].y == 2 && voxels[2].y == 2 && voxels[3].y == 2,
        "a stationary movable foothold should retain the bridged body");
}

void TestSearchCollectsEveryGem() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 2, 1, Role("goal"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 4, 4, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 3,
        "search should retain partial collection state until every gem is gone");
  Check(result.solution_length == 3 && result.solution[0] == 0 &&
            result.solution[1] == 0 && result.solution[2] == 0,
        "the multi-gem shortest path should collect both corridor gems");
}

void TestSearchStoresLargePolycubeAsOneEntity() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[48];
  int32_t count = 0;
  voxels[count++] = {0, 2, 1, Role("player"), -1};
  voxels[count++] = {0, 2, 0, Role("floor"), -1};
  voxels[count++] = {0, 1, 0, Role("floor"), -1};
  voxels[count++] = {0, 0, 0, Role("floor"), -1};
  voxels[count++] = {0, 0, 1, Role("goal"), -1};
  for (int32_t y = 3; y <= 6; ++y) {
    for (int32_t x = 2; x <= 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      voxels[count++] = {x, y, 1, Role("weightless-pushable"), 37};
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 8, 8, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 2,
        "a polycube larger than the old moving-voxel cap should remain searchable");
}

void TestGeneralSearchChecksRaisedPolycubeCollisions() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 0, 1, Role("player"), -1},
      {1, 0, 1, Role("weightless-pushable"), 4},
      {2, 0, 2, Role("weightless-pushable"), 4},
      {1, 0, 1, Role("goal"), -1},
      {3, 0, 1, Role("wall"), -1},
      {0, 0, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
      {3, 0, 0, Role("floor"), -1},
      {3, 0, 2, Role("wall"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 10, 4, 1, 1000);
  Check(result.status == voxelbench::SearchStatus::kUnsolved,
        "generalized search must collide raised polycube members with raised walls");

  result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 9, 4, 1, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "a raised polycube member may pass above a shorter wall");
}

void TestCappedSearchDoesNotClaimAnOptimalProof() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[45];
  int32_t count = 0;
  for (int32_t y = 0; y < 5; ++y) {
    for (int32_t x = 0; x < 5; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  for (int32_t x = 0; x < 5; ++x) {
    voxels[count++] = {x, 0, 1, Role("wall"), -1};
    voxels[count++] = {x, 4, 1, Role("wall"), -1};
  }
  for (int32_t y = 1; y < 4; ++y) {
    voxels[count++] = {0, y, 1, Role("wall"), -1};
    voxels[count++] = {4, y, 1, Role("wall"), -1};
  }
  voxels[count++] = {1, 2, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {2, 2, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {1, 3, 1, Role("player"), -1};
  voxels[count++] = {1, 1, 1, Role("goal"), -1};

  voxelbench::reset_workspace(&physics_workspace);
  const auto screened = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 5, 5, 5);
  Check(screened.status == voxelbench::SearchStatus::kSolvedUnproven &&
            screened.moves == 6,
        "a route found after state pruning must be marked solved-but-unproven");

  const auto proved = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 5, 5, 10000);
  Check(proved.status == voxelbench::SearchStatus::kSolved && proved.moves == 6,
        "the same route should become exact when the full frontier is retained");
}

void TestSlopeCarrierMovesStationaryRider() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 3, Role("weightless-pushable"), 1},
      {1, 1, 1, Role("ice-slope-down"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "a command matching the slope's downhill direction should run");
  Check(voxels[1].y == 0 && voxels[1].z == 1,
        "the bottom body should descend the slope");
  Check(voxels[2].y == 0 && voxels[2].z == 2,
        "a stationary body resting on the slope mover should ride with it");
}

void TestRemotePolycubeMemberCarriesPerpendicularSlopeRider() {
  voxelbench::Voxel voxels[25];
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 4; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("ice"), -1};
  voxels[count++] = {0, 1, 2, Role("ice-slope-left"), -1};
  voxels[count++] = {0, 1, 3, Role("weightless-pushable"), 0};
  voxels[count++] = {1, 1, 1, Role("ice"), -1};
  voxels[count++] = {1, 1, 2, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 1, 2, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 2, 1, Role("player"), -1};
  voxels[count++] = {3, 1, 1, Role("ice"), -1};

  Check(voxelbench::simulate_turn(voxels, count, 4, 4, 0) == 0,
        "a push through a remote slope contact should run");
  Check(voxels[18].y == 0,
        "every member of the pushed polycube should transmit slope contact");
}

void TestSlopeAndFlatIceBridgeNeedsDeliberatePush() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 1, Role("ice-slope-down"), -1},
      {2, 1, 0, Role("ice"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 3, 3, 0) == 0,
        "a command beside the mixed-support polycube should run");
  Check(voxels[1].y == 1 && voxels[2].y == 1 && voxels[3].y == 1,
        "a polycube bridging slope and flat Ice should remain stable without a push");
}

void TestOpposingSlopeLandingCancelsStoredMomentum() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 3, Role("player"), -1},
      {1, 4, 3, Role("weightless-pushable"), 0},
      {1, 3, 3, Role("weightless-pushable"), 0},
      {1, 4, 2, Role("wall"), -1},
      {1, 5, 2, Role("wall"), -1},
      {1, 3, 0, Role("ice-slope-down"), -1},
      {1, 2, 0, Role("ice-slope-up"), -1},
      {1, 1, 1, Role("ice-slope-up"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 7, 0) == 0,
        "a push that drops a body onto opposing slopes should run");
  Check(voxels[1].y == 3 && voxels[1].z == 1 &&
            voxels[2].y == 2 && voxels[2].z == 1,
        "opposing slope supports should cancel stored pre-fall momentum");
}

void TestPlayerEnteringLoweredLiftRaisesAndRides() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "entering a lowered player lift should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 2,
        "the raised lift should carry its entering player up one unit");
  Check(voxels[1].generic_id == 1,
        "entering a lowered lift should store its raised state");
}

void TestPlayerEnteringRaisedLiftLowersAndRides() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 1},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "entering a raised player lift should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the lowered lift should carry its entering player down one unit");
  Check(voxels[1].generic_id == 0,
        "entering a raised lift should store its lowered state");
}

void TestPlayerLiftToggleUsesItsOwnAnimationTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering a lift should expose the horizontal entry frame");
  Check(state.tick == 1 && voxels[0].y == 1 && voxels[0].z == 1 &&
            voxels[1].generic_id == 0,
        "the entry tick should not collapse the lift state change into movement");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the following animation tick should complete the lift toggle");
  Check(state.tick == 2 && voxels[0].z == 2 && voxels[1].generic_id == 1,
        "the second tick should raise both lift state and rider");
}

void TestLeavingAuthoredLoweredLiftKeepsItLowered() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "leaving an authored lowered lift should run");
  Check(voxels[0].y == 1 && voxels[1].generic_id == 0,
        "an ordinary lowered lift should remain lowered after departure");
}

void TestBlockedLoweredLiftRetriesAfterRiderLeaves() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player-lift"), 0},
      {1, 2, 2, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a rider should first leave its ceiling-blocked lift");
  Check(state.tick == 1 && voxels[0].y == 1 && voxels[1].generic_id == 0,
        "the departure frame should keep the blocked lift lowered");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the vacated lift should retry on its own following tick");
  Check(state.tick == 2 && voxels[1].generic_id == 1,
        "the unobstructed vacated lift should finish raised");
}

void TestLiftRidesWeightlessCarrierWithStatefulCollision() {
  voxelbench::Voxel lowered[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("player-lift"), 0},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(lowered, 6, 3, 5, 0) == 0,
        "a push carrying a lowered lift should run");
  Check(lowered[0].y == 2 && lowered[1].y == 1 && lowered[2].y == 1,
        "a lowered non-colliding lift should ride its weightless carrier");

  voxelbench::Voxel raised[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("player-lift"), 1},
      {1, 1, 2, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(raised, 7, 3, 5, 0) == 0,
        "a blocked raised lift carrier command should run");
  Check(raised[0].y == 3 && raised[1].y == 2 && raised[2].y == 2,
        "a raised lift caught on terrain should anchor its carrier");
}

void TestBlockedPlayerLiftRefusesToRaise() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 1, 2, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 3, 3, 0) == 0,
        "entering a headroom-blocked player lift should run");
  Check(voxels[0].y == 1 && voxels[0].z == 1 &&
            voxels[1].generic_id == 0,
        "a lift must remain lowered rather than embed its player in a blocker");
}

void TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder() {
  voxelbench::Voxel entering[] = {
      {2, 2, 1, Role("player"), -1},
      {2, 1, 1, Role("player-lift"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 1, 1, Role("wall"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(entering, 6, 5, 4, 0) == 0,
        "entering incompatible overlapping lifts should finish safely");
  Check(entering[0].y == 1 && entering[0].z == 1 &&
            entering[1].generic_id == 0 && entering[2].generic_id == 4,
        "overlapping lifts must cancel rather than select the first voxel");

  voxelbench::Voxel leaving[] = {
      {2, 1, 1, Role("player"), -1},
      {2, 1, 1, Role("player-lift"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 1, 1, Role("wall"), -1},
      {2, 1, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(leaving, 6, 5, 4, 0) == 0,
        "leaving incompatible overlapping lifts should finish safely");
  Check(leaving[0].y == 0 && leaving[1].generic_id == 0 &&
            leaving[2].generic_id == 4,
        "vacating an overlap must not raise an arbitrary first lift");
}

void TestOpposingPlayerLiftsRecoilMountedBodies() {
  voxelbench::Voxel voxels[] = {
      {3, 3, 1, Role("player"), -1},
      {3, 2, 1, Role("player-lift"), 4},
      {3, 2, 1, Role("player-lift"), 8},
      {2, 2, 1, Role("weightless-pushable"), 0},
      {4, 2, 1, Role("weightless-pushable"), 1},
      {3, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
      {5, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 11, 7, 5, 0) == 0,
        "opposed mounted lifts should resolve as one command");
  Check(voxels[0].x == 3 && voxels[0].y == 2 && voxels[0].z == 1,
        "balanced opposed lifts should leave their rider centered");
  Check(voxels[1].x == 2 && voxels[1].generic_id == 5 &&
            voxels[2].x == 4 && voxels[2].generic_id == 9,
        "both opposed lift fixtures should raise and recoil together");
  Check(voxels[3].x == 1 && voxels[4].x == 5,
        "each mounted body should receive its lift's recoil proposal");
}

void TestSearchTracksPlayerLiftState() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 1, 2, Role("goal"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 1 && result.solution_length == 1 &&
            result.solution[0] == 0,
        "exact search should preserve lift state while solving through a toggle");
}

void TestOrangeButtonUsesASeparateWallTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-button"), 0},
      {2, 1, 1, Role("orange-wall"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering an orange button should expose its entry frame");
  Check(state.tick == 1 && voxels[0].y == 1 &&
            voxels[1].generic_id == 0 && voxels[2].generic_id == 0,
        "the entry frame should precede the linked mechanism animation");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the linked orange-wall tick should complete the command");
  Check(state.tick == 2 && voxels[1].generic_id == 0 &&
            voxels[2].generic_id == 1,
        "button pressure should lower every wall without changing the button");
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 2) == 0 &&
            voxels[0].y == 2 && voxels[1].generic_id == 0 &&
            voxels[2].generic_id == 0,
        "leaving an orange button should release it and raise every wall");
}

void TestOrangeWallCarriesItsMountedButtonInTheSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-button"), 0},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 2, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering a button should precede its linked wall motion");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 2, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "a wall and its mounted button should share one mechanism tick");
  Check(state.tick == 2 && voxels[2].generic_id == 1 && voxels[3].z == 1,
        "a top-mounted button should descend with a wall that becomes a face");
  Check(voxelbench::simulate_turn(voxels, 7, 2, 3, 2) == 0 &&
            voxels[0].y == 2 && voxels[2].generic_id == 0 && voxels[3].z == 2,
        "the mounted button should rise with the wall after pressure is released");
}

void TestOrangeWallCarriesItsMountedLiftInTheSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      // Raised east-facing lift attached to the upper wall's east face.
      {2, 1, 2, Role("player-lift"), 5},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 3, 6, 0) ==
            voxelbench::TickResult::kMore,
        "entering a button should precede attached-lift wall motion");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 3, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "an Orange Wall and its mounted lift should share one mechanism tick");
  Check(state.tick == 2 && voxels[2].generic_id == 1 &&
            voxels[3].generic_id == 1 && voxels[4].z == 1 &&
            voxels[4].generic_id == 5,
        "a side-mounted lift should descend with its wall and retain its state");
}

void TestLoweredWallMountedLiftMayOverlapTerrain() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      {2, 1, 2, Role("player-lift"), 4},
      {2, 1, 1, Role("wall"), -1},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 6, 0) == 0,
        "a lowered wall-mounted lift may enter occupied terrain");
  Check(voxels[2].generic_id == 1 && voxels[3].generic_id == 1 &&
            voxels[4].z == 1 && voxels[4].generic_id == 4,
        "a lowered lift should remain attached while overlapping a solid cube");
}

void TestWallMountedLiftCannotDescendIntoFloor() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 6, 0) == 0,
        "a wall-mounted lift blocked by Row-0 Floor should finish safely");
  Check(voxels[2].generic_id == 0 && voxels[2].z == 1 &&
            voxels[3].z == 1,
        "Row-0 Floor should hold both the wall and its mounted lift in place");
}

void TestOrangeWallDeliversPlayerOntoMountedLift() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {2, 2, 1, Role("player"), -1},
      {2, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      {2, 1, 2, Role("player-lift"), 4},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {3, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the player should first enter the wall button");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the wall should next lower its mounted lift onto the player");
  Check(state.tick == 2 && voxels[4].z == 1 && voxels[4].generic_id == 4,
        "the wall tick should expose the lowered side lift frame");
  const auto lift_tick = voxelbench::step_tick(
      &workspace, &state, voxels, 9, 4, 4, 0);
  if (lift_tick != voxelbench::TickResult::kComplete) {
    std::cerr << "lift delivery diagnostic: result="
              << static_cast<int32_t>(lift_tick) << " tick=" << state.tick
              << " phase=" << static_cast<int32_t>(state.phase)
              << " player=" << voxels[0].x << ',' << voxels[0].y << ','
              << voxels[0].z << " lift=" << voxels[4].z << '#'
              << voxels[4].generic_id << " wall=" << voxels[2].generic_id
              << ',' << voxels[3].generic_id << '\n';
  }
  Check(lift_tick == voxelbench::TickResult::kComplete,
        "a lift delivered onto the player should actuate on the next tick");
  Check(state.tick == 3 && voxels[0].x == 3 &&
            voxels[4].generic_id == 5,
        "the delivered side lift should raise and eject the player outward");
}

void TestOrangeButtonRidesTopLiftAndChangesVisibility() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 1},
      {2, 1, 1, Role("orange-button"), 4},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "entering a raised lift with an attached button should run");
  Check(voxels[0].z == 1 && voxels[1].generic_id == 0 &&
            voxels[2].z == 0 && voxels[2].generic_id == 5,
        "the attached button should lower with the lift and become hidden");
  voxels[0].y = 2;
  voxels[3].x = -1;
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "re-entering the lowered lift should run");
  Check(voxels[0].z == 2 && voxels[1].generic_id == 1 &&
            voxels[2].z == 1 && voxels[2].generic_id == 4,
        "the attached button should rise with the lift and become visible");
}

void TestMovingPolycubeCarriesButtonsMountedOnEveryFace() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("weightless-pushable"), 0},
      {0, 4, 1, Role("orange-button"), 8},
      {1, 3, 1, Role("orange-button"), 2},
      {1, 5, 1, Role("orange-button"), 6},
      {2, 4, 1, Role("orange-button"), 4},
      {1, 4, 2, Role("orange-button"), 0},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 12, 6, 6, 0) == 0,
        "pushing a button-covered polycube should run");
  Check(voxels[1].y == 3 && voxels[2].y == 3 && voxels[3].y == 2 &&
            voxels[4].y == 4 && voxels[5].y == 3 && voxels[6].y == 3,
        "buttons mounted on every face should translate with their host");
}

void TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining() {
  voxelbench::Voxel voxels[46]{};
  int32_t count = 0;
  int32_t upper_wall = -1;
  int32_t lower_wall = -1;
  for (int32_t x = 0; x < 6; ++x) {
    for (int32_t y = 0; y < 6; ++y) {
      if (x == 1 && y == 3) {
        lower_wall = count;
        voxels[count++] = {x, y, 1, Role("orange-wall"), 2};
      }
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      if (x == 1 && y == 2) {
        upper_wall = count;
        voxels[count++] = {x, y, 2, Role("orange-wall"), 2};
      }
      if (y != 3 || x < 1 || x > 3) continue;
      if (x == 1) {
        voxels[count++] = {x, y, 1, Role("player"), -1};
        voxels[count++] = {x, y, 2, Role("weightless-pushable"), 0};
      } else {
        voxels[count++] = {x, y, 1, Role("orange-button"), 0};
        voxels[count++] = {x, y, 1, Role("weightless-pushable"), 0};
        voxels[count++] = {x, y, 2, Role("weightless-pushable"), 0};
      }
    }
  }
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_turn(&workspace, voxels, count, 6, 6, 0) == 0,
        "releasing a carried orange-wall assembly should run");
  Check(voxels[upper_wall].generic_id == 0 &&
            voxels[lower_wall].generic_id == 0 &&
            voxels[upper_wall].y == 2 && voxels[lower_wall].y == 2,
        "every voxel in the newly joined orange column should fully raise");
}

void TestHeldButtonsPreserveOrangeWallAnchors() {
  voxelbench::Voxel voxels[30]{};
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("player"), -1};
  voxels[count++] = {2, 1, 1, Role("orange-button"), 0};
  voxels[count++] = {2, 2, 1, Role("orange-button"), 0};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {4, 2, 1, Role("orange-wall"), 0};
  voxels[count++] = {4, 2, 2, Role("orange-wall"), 0};
  const int32_t directions[] = {1, 2, 1, 3};
  const int32_t depths[] = {1, 1, 2, 1};
  for (int32_t step = 0; step < 4; ++step) {
    Check(voxelbench::simulate_turn(voxels, count, 6, 4, directions[step]) == 0,
          "held-button orange regression command should run");
    Check(voxels[28].z == 1 && voxels[29].z == 2 &&
              voxels[28].generic_id == depths[step] &&
              voxels[29].generic_id == depths[step],
          "partially normalized orange walls must keep their raised anchors");
  }
}

void TestOrangeControlScopesRemainIndependent() {
  const auto scoped = [](int32_t scope, int32_t value) {
    return voxelbench::kOrangeScopedIdFlag |
        (scope << voxelbench::kOrangeScopeShift) | value;
  };
  voxelbench::Voxel voxels[31]{};
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("player"), -1};
  voxels[count++] = {2, 1, 1, Role("orange-button"), scoped(1, 0)};
  voxels[count++] = {2, 2, 1, Role("orange-button"), scoped(2, 0)};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {4, 2, 1, Role("orange-wall"), scoped(1, 0)};
  voxels[count++] = {5, 2, 1, Role("orange-wall"), scoped(2, 0)};
  voxels[count++] = {4, 3, 1, Role("orange-wall"), 0};
  const int32_t directions[] = {1, 2, 1, 3};
  const int32_t second_depths[] = {0, 0, 1, 0};
  for (int32_t step = 0; step < 4; ++step) {
    Check(voxelbench::simulate_turn(voxels, count, 6, 4, directions[step]) == 0,
          "independent orange scopes should simulate");
    Check(voxels[28].generic_id == scoped(1, 1) &&
              voxels[29].generic_id == scoped(2, second_depths[step]) &&
              voxels[30].generic_id == 0,
          "even touching walls must listen only to buttons in their own scope");
    Check(voxels[28].z == 1 && voxels[29].z == 1 && voxels[30].z == 1,
          "independent controls must preserve raised wall anchors");
  }
}

void TestOrangeWallsCountEveryPressedButton() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("pushable"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 1, Role("orange-button"), 2},
      {2, 1, 1, Role("pushable"), -1},
      {2, 1, 0, Role("floor"), -1},
      {2, 2, 1, Role("solid"), -1},
      {3, 1, 3, Role("orange-wall"), 0},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 4, 3, 3) == 0,
        "a command should synchronize multiple pressed orange buttons");
  Check(voxels[2].generic_id == 0 && voxels[5].generic_id == 2,
        "button pressure should preserve the orientation-only mechanism IDs");
  Check(voxels[9].generic_id == 2,
        "two independently pressed buttons should lower a wall two units");
}

void TestFlattenedOrangeWallIsPassThroughOnFloor() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "walking through a button-flattened orange wall should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "a wall flattened against Floor should not block the player");
  Check(voxels[1].generic_id == 1 && voxels[2].generic_id == 0,
        "the final frame should retain wall depth without a button state");
}

void TestFloatingOrangeWallLowersAsACube() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("pushable"), -1},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 3) == 0,
        "a floating linked orange wall should finish its lowering tick");
  Check(voxels[2].generic_id == 1 && voxels[3].z == 1,
        "a wall over empty space should descend as a full cube and carry its rider");
}

void TestProjectedOrangeFaceTransitionsWithDepth() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      // Canonical C++ input stores the raised anchor (z=1) plus depth 1. The
      // floor at z=0 projects this record into a pass-through face at row 1.
      {1, 1, 1, Role("orange-wall"), 1},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0 &&
            voxels[0].y == 1 && voxels[1].generic_id == 1,
        "a projected Orange Face should remain pass-through while its button stays pressed");
  voxels[3].x = -1;
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 2) == 0 &&
            voxels[1].generic_id == 0,
        "a released Orange Face should return to a solid cube at depth zero");
}

void TestSearchTracksOrangeWallDepth() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 0, 1, Role("goal"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 9, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 2,
        "exact search should hash linked orange-wall depth and solve through it");
}

void TestPuncherRedirectsPlayerAndResetsVisually() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("puncher"), 2},  // Right-facing, unsprung.
      {0, 2, 1, Role("wall"), -1},
      {4, 2, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::simulate_command(
            &workspace, &state, voxels, 9, 5, 5, 0) == 0,
        "a player punch route should quiesce");
  Check(voxels[0].x == 3 && voxels[0].y == 2,
        "a puncher should redirect the player and preserve its impulse until blocked");
  Check(voxels[1].generic_id == 2,
        "a puncher should expose its sprung frame and reset before completion");
}

void TestInitialPuncherContactWaitsForCommand() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  std::vector<voxelbench::Voxel> voxels = {
      {2, 1, 1, Role("weightless-pushable"), 17},
      {2, 2, 1, Role("player"), -1},
      {2, 2, 1, Role("puncher"), 4},  // Down-facing, mounted to the front box.
      {2, 3, 1, Role("weightless-pushable"), 53},
      {2, 4, 1, Role("solid"), -1},
  };
  for (int32_t y = 0; y < 6; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels.push_back({x, y, 0, Role("floor"), -1});
    }
  }
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  const auto tick = [&]() {
    return voxelbench::step_tick(
        &workspace, &state, voxels.data(), static_cast<int32_t>(voxels.size()), 6, 6, 0);
  };
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 1,
        "the commanded push should precede the punch");
  Check(voxels[0].y == 0 && voxels[1].y == 1 && voxels[2].y == 1 &&
            voxels[2].generic_id == 4,
        "the player, box and mounted unsprung puncher should move together");
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 2 &&
            voxels[1].y == 2 && voxels[2].generic_id == 5,
        "the puncher should fire on the following tick");
  Check(tick() == voxelbench::TickResult::kComplete && state.tick == 3 &&
            voxels[1].y == 2 && voxels[2].y == 1 && voxels[2].generic_id == 4 &&
            voxels[3].y == 3,
        "the blocked punch should stop the player and reset the fixture visually");
}

void TestSearchSolvesAndReplaysPuncherCommands() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  for (int32_t sprung = 0; sprung <= 1; ++sprung) {
    voxelbench::Voxel voxels[] = {
        {1, 3, 1, Role("player"), -1},
        {1, 2, 1, Role("puncher"), 2 + sprung},
        {0, 2, 1, Role("wall"), -1},
        {4, 2, 1, Role("wall"), -1},
        {1, 3, 0, Role("floor"), -1},
        {1, 2, 0, Role("floor"), -1},
        {2, 2, 0, Role("floor"), -1},
        {3, 2, 0, Role("floor"), -1},
        {4, 2, 0, Role("floor"), -1},
        {3, 2, 1, Role("goal"), -1},
    };
    voxelbench::reset_workspace(&physics_workspace);
    const auto result = voxelbench::search_shortest(
        &search_workspace, &physics_workspace, voxels, 10, 5, 5, 1000);
    Check(result.status == voxelbench::SearchStatus::kSolved &&
              result.moves == (sprung == 0 ? 1 : 3) && result.solution[0] == 0,
          "search should preserve whether the authored puncher can fire");
    for (int32_t move = 0; move < result.solution_length; ++move) {
      Check(voxelbench::simulate_turn(voxels, 10, 5, 5, result.solution[move]) == 0,
            "a searched puncher command should replay in ordinary physics");
    }
    Check(voxels[0].x == 3 && voxels[0].y == 2 && voxels[9].x < 0 &&
              voxels[1].generic_id == 2 + sprung,
          "replayed puncher solution should collect the gem with the correct fixture state");
  }
}

void TestPuncherMomentumMovesAWholeWeightlessConvoy() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("puncher"), 2},  // Right-facing, unsprung.
      {2, 2, 1, Role("weightless-pushable"), 0},
      {0, 2, 1, Role("wall"), -1},
      {5, 2, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
      {5, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 11, 6, 5, 0) == 0,
        "a punch-driven weightless convoy should quiesce");
  Check(voxels[0].x == 3 && voxels[2].x == 4,
        "every body pushed by a punch should retain the convoy impulse");
}

void TestFloatingFloorHasOneBoxPushWeight() {
  voxelbench::Voxel one_platform[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(one_platform, 5, 6, 6, 0) == 0,
        "pushing one Floating Floor should run");
  Check(one_platform[0].y == 4 && one_platform[1].y == 3,
        "one Floating Floor should push like one ordinary box");

  voxelbench::Voxel two_platforms[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 1, Role("floating-floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(two_platforms, 7, 6, 6, 0) == 0,
        "a blocked Floating Floor push should run");
  Check(two_platforms[0].y == 5 && two_platforms[1].y == 4 &&
            two_platforms[2].y == 3,
        "two Floating Floors should be too heavy to push together");
}

void TestFloatingFloorFillsHoleOnFollowingTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 6, 6, 0) ==
            voxelbench::TickResult::kMore,
        "a Floating Floor over a hole should expose its horizontal frame");
  Check(state.tick == 1 && voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[1].z == 1 && voxels[1].role == Role("floating-floor"),
        "the pushed platform should remain suspended for the movement tick");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 6, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "the Floating Floor hole-fill tick should complete the command");
  Check(state.tick == 2 && voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[1].z == 0 && voxels[1].role == Role("floor"),
        "the platform should become permanent Floor in the Row-0 hole");
}

void TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains() {
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 1, Role("weightless-pushable"), 0},
      {0, 2, 1, Role("weightless-pushable"), 1},
      {0, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 6, 6, 0) == 0,
        "a mixed Floating Floor and weightless chain push should run");
  Check(voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[2].y == 2 && voxels[3].y == 1,
        "one weighted platform should transmit through any weightless chain");
}

void TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid() {
  voxelbench::Voxel walk[] = {
      {0, 5, 2, Role("player"), -1},
      {0, 5, 1, Role("solid"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(walk, 5, 6, 6, 0) == 0,
        "walking toward a Floating Floor top should run");
  Check(walk[0].y == 5,
        "Floating Floor should not provide a walkable top surface");

  voxelbench::Voxel high_push[] = {
      {0, 4, 4, Role("player"), -1},
      {0, 3, 4, Role("floating-floor"), -1},
      {0, 3, 3, Role("solid"), -1},
      {0, 4, 3, Role("solid"), -1},
      {0, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(high_push, 5, 6, 6, 0) == 0,
        "an unsupported high Floating Floor push should run");
  Check(high_push[0].y == 4 && high_push[1].y == 3 &&
            high_push[1].z == 4,
        "a deliberate push must not launch Floating Floor into high void");
}

void TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked() {
  for (const bool remote_slope : {false, true}) {
    voxelbench::Voxel voxels[9] = {
        {0, 4, 1, Role("player"), -1},
        {0, 5, 1, Role("clone"), 0},
        {0, 3, 1, Role("floating-floor"), -1},
        {0, 2, 1, Role("floating-floor"), -1},
        {0, 2, 0, Role("floor"), -1},
        {0, 3, 0, Role("floor"), -1},
        {0, 4, 0, Role("floor"), -1},
        {0, 5, 0, Role("floor"), -1},
    };
    if (remote_slope) voxels[8] = {5, 5, 1, Role("ice-slope-right"), -1};
    Check(voxelbench::simulate_turn(voxels, remote_slope ? 9 : 8, 6, 6, 0) == 0,
          "a blocked player and trailing clone command should run");
    Check(voxels[0].y == 4 && voxels[1].y == 5 &&
              voxels[2].y == 3 && voxels[3].y == 2,
          "the clone must retain its cell when the player cannot vacate");
  }
}

void TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer() {
  voxelbench::Voxel voxels[] = {
      {0, 4, 1, Role("player"), -1},
      {0, 3, 2, Role("floating-floor"), -1},
      {0, 3, 1, Role("ice-slope-up"), -1},
      {0, 2, 1, Role("solid"), -1},
      {0, 1, 2, Role("floating-floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 6, 6, 0) == 0,
        "a Floating Floor slope-jam command should run");
  Check(voxels[0].y == 4 && voxels[0].z == 1 &&
            voxels[1].y == 2 && voxels[1].z == 2 &&
            voxels[4].y == 1 && voxels[4].z == 2,
        "the authored platform should hover while the blocked slope actor recoils");
}

void TestSlopeMomentumPushesSupportedFloatingFloor() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int scenario = 0; scenario < 3; ++scenario) {
    const bool downhill = scenario == 2;
    const bool supported = scenario != 1;
    voxelbench::Voxel voxels[11] = {
        {0, 5, downhill ? 2 : 1, Role("player"), -1},
        {0, 3, downhill ? 1 : 2, Role("floating-floor"), -1},
        {0, 4, 1, Role(downhill ? "ice-slope-down" : "ice-slope-up"), -1},
        {0, downhill ? 5 : 3, 1, Role("solid"), -1},
    };
    int32_t count = 4;
    for (int32_t y = 0; y < 6; ++y) {
      voxels[count++] = {0, y, 0, Role("floor"), -1};
    }
    if (!downhill && supported) {
      voxels[count++] = {0, 2, 1, Role("solid"), -1};
    }
    voxelbench::reset_workspace(&workspace);
    voxelbench::reset_motion_state(&state);
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0) ==
              voxelbench::TickResult::kMore,
          "ramp entry must expose its intermediate frame");
    Check(state.tick == 1 && voxels[0].y == 4 && voxels[0].z == 2 &&
              voxels[1].y == 3,
          "ramp entry must not push the Floating Floor a tick early");
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0) ==
              voxelbench::TickResult::kComplete,
          "ramp contact should resolve on the second tick");
    Check(state.tick == 2 && voxels[0].y == (supported ? 3 : 5) &&
              voxels[0].z == (downhill || !supported ? 1 : 2) &&
              voxels[1].y == (supported ? 2 : 3) &&
              voxels[1].z == (downhill ? 1 : 2) &&
              voxels[1].role == Role("floating-floor"),
          "supported ramp contact pushes; unsupported crest contact reflects");
  }
}

void TestSearchTracksFilledFloatingFloorState() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 4, 1, Role("player"), -1},
      {0, 3, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {0, 0, 0, Role("floor"), -1},
      {0, 1, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 5, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 3 && result.solution_length == 3,
        "search should retain a Floating Floor after it permanently fills a hole");
  Check(result.solution[0] == 0 && result.solution[1] == 0 &&
            result.solution[2] == 0,
        "search should cross the filled hole and collect the gem");
}

void TestSearchPreservesAuthoredGateTiming() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  for (const int32_t raised : {0, 1}) {
    voxelbench::Voxel voxels[20] = {
        {1, 3, 1, Role("player"), -1},
        {1, 0, 1, Role("goal"), -1},
        {1, 2, 1, Role("player-gate"), raised},
    };
    int32_t count = 3;
    for (int32_t x = 0; x < 4; ++x) {
      for (int32_t y = 0; y < 4; ++y) {
        voxels[count++] = {x, y, 0, Role("floor"), -1};
      }
    }
    const auto result = voxelbench::search_shortest(&search_workspace,
        &physics_workspace, voxels, count, 4, 4, 1000);
    Check(result.status == voxelbench::SearchStatus::kSolved &&
              result.moves == (raised == 0 ? 3 : 5),
          "exact search must preserve authored gate state before the first input");
    for (int32_t i = 0; i < result.solution_length; ++i) {
      Check(voxelbench::simulate_turn(voxels, count, 4, 4,
                result.solution[i]) == 0, "gate solution commands must replay");
    }
    Check(voxels[1].x < 0, "the shortest gate witness must collect its gem");
  }
}

void TestSearchManyFixedGatesDoNotConsumeEntityBudget() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  std::vector<voxelbench::Voxel> voxels = {
      {0, 3, 1, Role("player"), -1},
      {0, 0, 1, Role("goal"), -1},
  };
  for (int32_t x = 0; x < 10; ++x) {
    for (int32_t y = 0; y < 10; ++y) {
      voxels.push_back({x, y, 0, Role("floor"), -1});
      if (x >= 2) voxels.push_back({x, y, 1, Role("player-gate"), (x + y) % 2});
    }
  }
  const int32_t count = static_cast<int32_t>(voxels.size());
  const auto result = voxelbench::search_shortest(&search_workspace,
      &physics_workspace, voxels.data(), count, 10, 10, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 3,
        "80 fixed gates must retain their states without exhausting the entity budget");
  for (int32_t i = 0; i < result.solution_length; ++i) {
    Check(voxelbench::simulate_turn(voxels.data(), count, 10, 10,
              result.solution[i]) == 0, "many-gate witness must replay");
  }
  Check(voxels[1].x < 0, "many-gate witness must collect the gem");
}

void TestReachableEdgesWithoutGems() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[10] = {
      {1, 1, 1, Role("player"), -1},
  };
  int32_t count = 1;
  for (int32_t y = 0; y < 3; ++y) {
    for (int32_t x = 0; x < 3; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto edges = voxelbench::search_reachable_edges(
      &search_workspace, &physics_workspace, voxels, count, 3, 3, 1000);
  Check(edges.status == voxelbench::SearchStatus::kSolved && edges.edges == 12,
        "edge search should exhaustively retain each outward perimeter route without gems");
  for (int32_t edge = 0; edge < edges.edges; ++edge) {
    const auto route = voxelbench::search_edge_solution(
        &search_workspace, &physics_workspace, edge, count, 3, 3);
    Check(route.status == voxelbench::SearchStatus::kSolved &&
              route.solution_length >= 2 && route.solution_length == route.moves,
          "each reachable edge should reconstruct a complete shortest witness");
  }

  voxelbench::Voxel dynamic_voxels[14] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), 0},
  };
  count = 2;
  for (int32_t y = 0; y < 3; ++y) {
    for (int32_t x = 0; x < 4; ++x) {
      dynamic_voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  const auto dynamic_edges = voxelbench::search_reachable_edges(
      &search_workspace, &physics_workspace, dynamic_voxels, count, 4, 3, 1000);
  Check(dynamic_edges.status == voxelbench::SearchStatus::kSolved &&
            dynamic_edges.edges > 14,
        "coincident edge coordinates with different crate states should remain distinct");
}

}  // namespace

int main() {
  Run(TestSimplePush, "TestSimplePush");
  Run(TestWrappingPushMovesPlayerSupport, "TestWrappingPushMovesPlayerSupport");
  Run(TestPlayerGateRisesWhenPlayerApproaches, "TestPlayerGateRisesWhenPlayerApproaches");
  Run(TestPlayerGateBlockedByEveryPushableFamily, "TestPlayerGateBlockedByEveryPushableFamily");
  Run(TestPlayerIceSlide, "TestPlayerIceSlide");
  Run(TestApproachingIceFromWallDoesNotStartSlidingEarly, "TestApproachingIceFromWallDoesNotStartSlidingEarly");
  Run(TestSlidingMomentumEntersRampSide, "TestSlidingMomentumEntersRampSide");
  Run(TestWalkingCannotEnterRampSide, "TestWalkingCannotEnterRampSide");
  Run(TestRampSideSlideStillCollidesWithSolids, "TestRampSideSlideStillCollidesWithSolids");
  Run(TestRampCrestPushesOnlyUnblockedWeightlessChains, "TestRampCrestPushesOnlyUnblockedWeightlessChains");
  Run(TestSparseStackCarryIgnoresUnrelatedSlopes, "TestSparseStackCarryIgnoresUnrelatedSlopes");
  Run(TestInterlockedPushDoesNotInventMomentum, "TestInterlockedPushDoesNotInventMomentum");
  Run(TestCarrierMomentumCannotLeakIntoNextScene, "TestCarrierMomentumCannotLeakIntoNextScene");
  Run(TestBlockedPassengersDoNotAnchorTheirCarrier, "TestBlockedPassengersDoNotAnchorTheirCarrier");
  Run(TestPushableIceSlide, "TestPushableIceSlide");
  Run(TestPlayerAndPushedBodySlideTogetherOnIce, "TestPlayerAndPushedBodySlideTogetherOnIce");
  Run(TestIceStopsAtObstacle, "TestIceStopsAtObstacle");
  Run(TestUnknownRoleBlocks, "TestUnknownRoleBlocks");
  Run(TestIndependentCloneCommands, "TestIndependentCloneCommands");
  Run(TestBlueSlopeAndBoxShareTheirGenericBody, "TestBlueSlopeAndBoxShareTheirGenericBody");
  Run(TestYellowSlopeAndCloneShareTheirGenericBody, "TestYellowSlopeAndCloneShareTheirGenericBody");
  Run(TestInterlockingCloneCommandComponent, "TestInterlockingCloneCommandComponent");
  Run(TestExactSearchTracksCloneActors, "TestExactSearchTracksCloneActors");
  Run(TestPlayerPolycubeMovesAndFallsRigidly, "TestPlayerPolycubeMovesAndFallsRigidly");
  Run(TestExactSearchTracksPlayerPolycube, "TestExactSearchTracksPlayerPolycube");
  Run(TestEveryBoundary, "TestEveryBoundary");
  Run(TestTickTraceAndWorkspaceIsolation, "TestTickTraceAndWorkspaceIsolation");
  Run(TestObserverReceivesNoMovementCompletionFrame, "TestObserverReceivesNoMovementCompletionFrame");
  Run(TestPreparedMotionStateClearsImmutableSuffix, "TestPreparedMotionStateClearsImmutableSuffix");
  Run(TestPreparedSceneRejectsMovableStaticSuffix, "TestPreparedSceneRejectsMovableStaticSuffix");
  Run(TestPreparedIndexesDoNotLeakToDifferentSceneShape, "TestPreparedIndexesDoNotLeakToDifferentSceneShape");
  Run(TestInvalidQuiescentCallDoesNotLeakItsAssumption, "TestInvalidQuiescentCallDoesNotLeakItsAssumption");
  Run(TestPlayerGetsVisibleRowZeroVoidFrame, "TestPlayerGetsVisibleRowZeroVoidFrame");
  Run(TestPushableGetsVisibleRowZeroVoidFrame, "TestPushableGetsVisibleRowZeroVoidFrame");
  Run(TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero, "TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero");
  Run(TestPolycubeAbyssUsesLowestOtherWorldGeometry, "TestPolycubeAbyssUsesLowestOtherWorldGeometry");
  Run(TestPlayerAbyssUsesLowestOtherWorldGeometry, "TestPlayerAbyssUsesLowestOtherWorldGeometry");
  Run(TestFallingRiderDoesNotExtendItsCarriersAbyss, "TestFallingRiderDoesNotExtendItsCarriersAbyss");
  Run(TestObjectAboveDescendingPlayerFallsInSameTick, "TestObjectAboveDescendingPlayerFallsInSameTick");
  Run(TestExactSearchFindsShortestCommands, "TestExactSearchFindsShortestCommands");
  Run(TestFlatIceSearchKeepsExactCommandSemantics, "TestFlatIceSearchKeepsExactCommandSemantics");
  Run(TestGeneralSearchSupportsBoardsWiderThanSixteen, "TestGeneralSearchSupportsBoardsWiderThanSixteen");
  Run(TestGeneralSearchCollapsesWalkingBeforePushes, "TestGeneralSearchCollapsesWalkingBeforePushes");
  Run(TestGeneralSearchMatchesMazeBenchEngine3LongRoom, "TestGeneralSearchMatchesMazeBenchEngine3LongRoom");
  Run(TestSearchInitializesFreshWorkspace, "TestSearchInitializesFreshWorkspace");
  Run(TestSearchPrunesPlayerGameOverBranches, "TestSearchPrunesPlayerGameOverBranches");
  Run(TestPlayerCollectsGemOnlyAtCommandEnd, "TestPlayerCollectsGemOnlyAtCommandEnd");
  Run(TestBoxMayOverlapGemWithoutCollectingIt, "TestBoxMayOverlapGemWithoutCollectingIt");
  Run(TestSlidingAcrossGemDoesNotCollectIt, "TestSlidingAcrossGemDoesNotCollectIt");
  Run(TestPlayerSettlesBeforeHorizontalInput, "TestPlayerSettlesBeforeHorizontalInput");
  Run(TestPolycubeSettlesAsOneBodyBeforeHorizontalInput, "TestPolycubeSettlesAsOneBodyBeforeHorizontalInput");
  Run(TestSearchRequiresACommandToCollectStartingGem, "TestSearchRequiresACommandToCollectStartingGem");
  Run(TestPushCannotWalkPlayerOffWallSupport, "TestPushCannotWalkPlayerOffWallSupport");
  Run(TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt, "TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt");
  Run(TestPlayerDepartureDoesNotCarryMultiplySupportedBody, "TestPlayerDepartureDoesNotCarryMultiplySupportedBody");
  Run(TestSearchCollectsEveryGem, "TestSearchCollectsEveryGem");
  Run(TestSearchStoresLargePolycubeAsOneEntity, "TestSearchStoresLargePolycubeAsOneEntity");
  Run(TestGeneralSearchChecksRaisedPolycubeCollisions, "TestGeneralSearchChecksRaisedPolycubeCollisions");
  Run(TestCappedSearchDoesNotClaimAnOptimalProof, "TestCappedSearchDoesNotClaimAnOptimalProof");
  Run(TestSlopeCarrierMovesStationaryRider, "TestSlopeCarrierMovesStationaryRider");
  Run(TestRemotePolycubeMemberCarriesPerpendicularSlopeRider, "TestRemotePolycubeMemberCarriesPerpendicularSlopeRider");
  Run(TestSlopeAndFlatIceBridgeNeedsDeliberatePush, "TestSlopeAndFlatIceBridgeNeedsDeliberatePush");
  Run(TestOpposingSlopeLandingCancelsStoredMomentum, "TestOpposingSlopeLandingCancelsStoredMomentum");
  Run(TestPlayerEnteringLoweredLiftRaisesAndRides, "TestPlayerEnteringLoweredLiftRaisesAndRides");
  Run(TestPlayerEnteringRaisedLiftLowersAndRides, "TestPlayerEnteringRaisedLiftLowersAndRides");
  Run(TestPlayerLiftToggleUsesItsOwnAnimationTick, "TestPlayerLiftToggleUsesItsOwnAnimationTick");
  Run(TestLeavingAuthoredLoweredLiftKeepsItLowered, "TestLeavingAuthoredLoweredLiftKeepsItLowered");
  Run(TestBlockedLoweredLiftRetriesAfterRiderLeaves, "TestBlockedLoweredLiftRetriesAfterRiderLeaves");
  Run(TestLiftRidesWeightlessCarrierWithStatefulCollision, "TestLiftRidesWeightlessCarrierWithStatefulCollision");
  Run(TestBlockedPlayerLiftRefusesToRaise, "TestBlockedPlayerLiftRefusesToRaise");
  Run(TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder, "TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder");
  Run(TestOpposingPlayerLiftsRecoilMountedBodies, "TestOpposingPlayerLiftsRecoilMountedBodies");
  Run(TestSearchTracksPlayerLiftState, "TestSearchTracksPlayerLiftState");
  Run(TestOrangeButtonUsesASeparateWallTick, "TestOrangeButtonUsesASeparateWallTick");
  Run(TestOrangeWallCarriesItsMountedButtonInTheSameTick, "TestOrangeWallCarriesItsMountedButtonInTheSameTick");
  Run(TestOrangeWallCarriesItsMountedLiftInTheSameTick, "TestOrangeWallCarriesItsMountedLiftInTheSameTick");
  Run(TestLoweredWallMountedLiftMayOverlapTerrain, "TestLoweredWallMountedLiftMayOverlapTerrain");
  Run(TestWallMountedLiftCannotDescendIntoFloor, "TestWallMountedLiftCannotDescendIntoFloor");
  Run(TestOrangeWallDeliversPlayerOntoMountedLift, "TestOrangeWallDeliversPlayerOntoMountedLift");
  Run(TestOrangeButtonRidesTopLiftAndChangesVisibility, "TestOrangeButtonRidesTopLiftAndChangesVisibility");
  Run(TestMovingPolycubeCarriesButtonsMountedOnEveryFace, "TestMovingPolycubeCarriesButtonsMountedOnEveryFace");
  Run(TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining, "TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining");
  Run(TestHeldButtonsPreserveOrangeWallAnchors, "TestHeldButtonsPreserveOrangeWallAnchors");
  Run(TestOrangeControlScopesRemainIndependent, "TestOrangeControlScopesRemainIndependent");
  Run(TestOrangeWallsCountEveryPressedButton, "TestOrangeWallsCountEveryPressedButton");
  Run(TestFlattenedOrangeWallIsPassThroughOnFloor, "TestFlattenedOrangeWallIsPassThroughOnFloor");
  Run(TestFloatingOrangeWallLowersAsACube, "TestFloatingOrangeWallLowersAsACube");
  Run(TestProjectedOrangeFaceTransitionsWithDepth, "TestProjectedOrangeFaceTransitionsWithDepth");
  Run(TestSearchTracksOrangeWallDepth, "TestSearchTracksOrangeWallDepth");
  Run(TestPuncherRedirectsPlayerAndResetsVisually, "TestPuncherRedirectsPlayerAndResetsVisually");
  Run(TestInitialPuncherContactWaitsForCommand, "TestInitialPuncherContactWaitsForCommand");
  Run(TestSearchSolvesAndReplaysPuncherCommands, "TestSearchSolvesAndReplaysPuncherCommands");
  Run(TestPuncherMomentumMovesAWholeWeightlessConvoy, "TestPuncherMomentumMovesAWholeWeightlessConvoy");
  Run(TestFloatingFloorHasOneBoxPushWeight, "TestFloatingFloorHasOneBoxPushWeight");
  Run(TestFloatingFloorFillsHoleOnFollowingTick, "TestFloatingFloorFillsHoleOnFollowingTick");
  Run(TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains, "TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains");
  Run(TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid, "TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid");
  Run(TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked, "TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked");
  Run(TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer, "TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer");
  Run(TestSlopeMomentumPushesSupportedFloatingFloor, "TestSlopeMomentumPushesSupportedFloatingFloor");
  Run(TestSearchTracksFilledFloatingFloorState, "TestSearchTracksFilledFloatingFloorState");
  Run(TestSearchPreservesAuthoredGateTiming, "TestSearchPreservesAuthoredGateTiming");
  Run(TestSearchManyFixedGatesDoNotConsumeEntityBudget, "TestSearchManyFixedGatesDoNotConsumeEntityBudget");
  Run(TestReachableEdgesWithoutGems, "TestReachableEdgesWithoutGems");
  if (failures != 0) {
    std::cerr << failures << " C++ physics test(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "all " << tests_run << " C++ physics/search tests passed\n";
  return EXIT_SUCCESS;
}
