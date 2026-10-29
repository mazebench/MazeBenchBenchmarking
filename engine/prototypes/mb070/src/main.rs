use mb070_physics::{role, step, Voxel};
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut t = input.split_whitespace();
    let w: i32 = t.next().unwrap().parse().unwrap();
    let h: i32 = t.next().unwrap().parse().unwrap();
    let count: usize = t.next().unwrap().parse().unwrap();
    let commands = t.next().unwrap().to_owned();
    let mut v = Vec::new();
    for _ in 0..count {
        v.push(Voxel {
            x: t.next().unwrap().parse().unwrap(),
            y: t.next().unwrap().parse().unwrap(),
            z: t.next().unwrap().parse().unwrap(),
            role: role(t.next().unwrap()),
            id: t.next().unwrap().parse().unwrap(),
        });
    }
    for d in commands.bytes() {
        let result = step(&mut v, w, h, (d - b'0') as i32);
        assert_eq!(result, 0);
        print!("{} 1", result);
        for a in &v {
            print!(" {} {} {} {} {}", a.x, a.y, a.z, a.role, a.id);
        }
        println!();
    }
}
