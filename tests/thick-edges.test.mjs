import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { ThickEdges, OUTLINE_WIDTH_PX } from "../ui/thick-edges.mjs";

test("active and dimmed outlines expand to the same three-pixel black stroke in a single pass", () => {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0], 3));
  for (const material of [edgeMaterial(), edgeMaterial(0x111820,.58)]) root.add(new THREE.LineSegments(geometry.clone(), material));
  const edges = new ThickEdges(); edges.apply(root);
  assert.equal(OUTLINE_WIDTH_PX, 3);
  for (const mesh of root.children) {
    assert(mesh.isMesh && mesh.userData.mazeWideOutline);
    assert.equal(mesh.material.color.getHex(), 0);
    assert.equal(mesh.material.opacity, 1);
    assert.equal(mesh.layers.mask, 1);
    assert.equal(mesh.geometry.attributes.position.count, 6);
    assert.equal(mesh.geometry.attributes.lineOther.count, 6);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader };
    mesh.material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.mazeLineWidth.value, 3);
    assert(shader.vertexShader.includes("mazeLineWidth / mazeLineViewport * gl_Position.w"));
  }
  const before = [...root.children]; edges.apply(root);
  assert.deepEqual(root.children, before);
});
