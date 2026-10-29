//! Deliberately bounded flat-floor physics prototype; not the production ABI.
#![cfg_attr(target_arch = "wasm32", no_std)]
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

pub const CAPACITY: usize = 128;
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Voxel {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub role: u32,
    pub id: i32,
}
pub const fn role(s: &str) -> u32 {
    let b = s.as_bytes();
    let mut h = 2166136261u32;
    let mut i = 0;
    while i < b.len() {
        h = (h ^ b[i] as u32).wrapping_mul(16777619);
        i += 1;
    }
    h
}
const PLAYER: u32 = role("player");
const BOX: u32 = role("pushable");
const FLOOR: u32 = role("floor");
const WALL: u32 = role("wall");
const GOAL: u32 = role("goal");

/// Validate the entire supported domain before making any mutation.
/// Full rectangular floor at z=-1, single-cell actors at z=0, no rigid IDs.
pub fn validate(v: &[Voxel], w: i32, h: i32) -> bool {
    if w <= 0 || h <= 0 || w > 64 || h > 64 || v.len() > CAPACITY {
        return false;
    }
    if v.iter().filter(|a| a.role == PLAYER).count() != 1 {
        return false;
    }
    for (i, a) in v.iter().enumerate() {
        if a.id != -1 || ![PLAYER, BOX, FLOOR, WALL, GOAL].contains(&a.role) {
            return false;
        }
        if a.role == GOAL && a.x == -1 {
            continue;
        }
        if a.x < 0 || a.y < 0 || a.x >= w || a.y >= h || a.z != if a.role == FLOOR { -1 } else { 0 }
        {
            return false;
        }
        for b in &v[..i] {
            if a.x == b.x && a.y == b.y && a.z == b.z && a.role != GOAL && b.role != GOAL {
                return false;
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            if !v.iter().any(|a| a.role == FLOOR && a.x == x && a.y == y) {
                return false;
            }
        }
    }
    true
}

/// One completed command tick. -3 = unsupported scene, -1 = invalid direction.
/// Reference behavior includes a tick for blocked commands and goal collection
/// only on completion. A push is committed only after the entire chain validates.
pub fn step(v: &mut [Voxel], w: i32, h: i32, d: i32) -> i32 {
    if !(0..4).contains(&d) {
        return -1;
    }
    if !validate(v, w, h) {
        return -3;
    }
    let p = v.iter().position(|a| a.role == PLAYER).unwrap();
    let (dx, dy) = [(0, -1), (1, 0), (0, 1), (-1, 0)][d as usize];
    let mut chain = [0usize; CAPACITY];
    let mut n = 1;
    chain[0] = p;
    let (mut x, mut y) = (v[p].x + dx, v[p].y + dy);
    let allowed = loop {
        if x < 0 || y < 0 || x >= w || y >= h {
            break false;
        }
        match v
            .iter()
            .position(|a| a.x == x && a.y == y && a.z == 0 && a.role != GOAL)
        {
            None => break true,
            Some(i) if v[i].role == BOX && n == 1 => {
                chain[n] = i;
                n += 1;
                x += dx;
                y += dy;
            }
            _ => break false,
        }
    };
    if allowed {
        for &i in &chain[..n] {
            v[i].x += dx;
            v[i].y += dy;
        }
    }
    let player = v[p];
    for a in v.iter_mut() {
        if a.role == GOAL && a.x == player.x && a.y == player.y && a.z == player.z {
            a.x = -1;
        }
    }
    0
}

// Single-instance, synchronous WASM scratch ABI. Hosts upload exactly count
// records before stepping; validation failures leave the upload untouched.
#[cfg(target_arch = "wasm32")]
static mut BUFFER: [Voxel; CAPACITY] = [Voxel {
    x: 0,
    y: 0,
    z: 0,
    role: 0,
    id: 0,
}; CAPACITY];
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn voxel_buffer() -> *mut Voxel {
    core::ptr::addr_of_mut!(BUFFER).cast()
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn step_tick(count: usize, w: i32, h: i32, d: i32) -> i32 {
    if count > CAPACITY {
        return -3;
    }
    unsafe {
        step(
            core::slice::from_raw_parts_mut(voxel_buffer(), count),
            w,
            h,
            d,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_is_atomic() {
        let mut v = [Voxel {
            role: PLAYER,
            id: -1,
            ..Voxel::default()
        }];
        let before = v;
        assert_eq!(step(&mut v, 1, 1, 0), -3);
        assert_eq!(v, before);
        assert_eq!(step(&mut v, 1, 1, 4), -1);
        assert_eq!(v, before);
    }
}
