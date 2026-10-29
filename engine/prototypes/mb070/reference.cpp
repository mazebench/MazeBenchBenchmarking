#include "voxelbench/physics.hpp"
#include <iostream>
#include <memory>
#include <string>
#include <vector>
int main() {
  int w,h,count; std::string commands; std::cin >> w >> h >> count >> commands;
  if (!std::cin || count < 1 || count > 128) return 2;
  std::vector<voxelbench::Voxel> v(count);
  for (auto& a:v) { std::string role; std::cin >> a.x >> a.y >> a.z >> role >> a.generic_id; a.role=voxelbench::hash_role(reinterpret_cast<const uint8_t*>(role.data()),static_cast<int>(role.size())); }
  auto workspace=std::make_unique<voxelbench::PhysicsWorkspace>();
  auto motion=std::make_unique<voxelbench::MotionState>();
  voxelbench::reset_workspace(workspace.get());
  for(char d:commands) {
    voxelbench::reset_motion_state(motion.get());
    for(int guard=0;guard<100;++guard) {
      auto result=voxelbench::step_command_tick(workspace.get(),motion.get(),v.data(),count,w,h,d-'0');
      std::cout << static_cast<int>(result) << ' ' << motion->tick;
      for(const auto& a:v) std::cout << ' ' << a.x << ' ' << a.y << ' ' << a.z << ' ' << a.role << ' ' << a.generic_id;
      std::cout << '\n';
      if(result==voxelbench::TickResult::kComplete) break;
      if(result!=voxelbench::TickResult::kMore || guard==99) return 3;
    }
  }
}
