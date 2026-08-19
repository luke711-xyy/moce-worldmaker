import * as THREE from 'three'

/**
 * The editor stores voxels as X/Y ground + Z height, while Three.js uses
 * X/Y/Z with Y as the conventional up axis in most of its examples. The
 * renderer in this project deliberately maps storage Y to Three Z and
 * storage Z to Three Y. Keep that conversion in one place so previews and
 * the WebGL viewport use the same face directions.
 */
export type StorageNormal = readonly [number, number, number]

export const STUDIO_RENDER_SETTINGS = {
  exposure: 1.05,
  roughness: 0.9,
  metalness: 0,
  aoFloor: 0.86,
  aoStrength: 0.14,
  minFaceLight: 0.7,
  maxFaceLight: 1.08,
} as const

export const STUDIO_LIGHTING = {
  hemisphere: {
    skyColor: '#fff4e5',
    groundColor: '#35434a',
    intensity: 1.55,
  },
  key: {
    color: '#ffe2c2',
    intensity: 1.0,
    position: [14, 18, 22] as const,
  },
  fill: {
    color: '#c9dcff',
    intensity: 0.72,
    position: [-18, 12, -14] as const,
  },
  yPositive: {
    color: '#e1efff',
    intensity: 0.72,
    position: [0, 8, 24] as const,
  },
  rim: {
    color: '#ffd8bc',
    intensity: 0.18,
    position: [2, 8, -24] as const,
  },
} as const

export function storageNormalToThree(normal: StorageNormal): THREE.Vector3 {
  return new THREE.Vector3(normal[0], normal[2], normal[1]).normalize()
}

export function createStudioMaterial(parameters: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    roughness: STUDIO_RENDER_SETTINGS.roughness,
    metalness: STUDIO_RENDER_SETTINGS.metalness,
    ...parameters,
  })
}

export function createStudioLights(scene: THREE.Scene): {
  hemisphere: THREE.HemisphereLight
  key: THREE.DirectionalLight
  fill: THREE.DirectionalLight
  yPositive: THREE.DirectionalLight
  rim: THREE.DirectionalLight
} {
  const hemisphere = new THREE.HemisphereLight(
    STUDIO_LIGHTING.hemisphere.skyColor,
    STUDIO_LIGHTING.hemisphere.groundColor,
    STUDIO_LIGHTING.hemisphere.intensity,
  )
  const key = new THREE.DirectionalLight(STUDIO_LIGHTING.key.color, STUDIO_LIGHTING.key.intensity)
  key.position.set(...STUDIO_LIGHTING.key.position)
  key.castShadow = true
  const fill = new THREE.DirectionalLight(STUDIO_LIGHTING.fill.color, STUDIO_LIGHTING.fill.intensity)
  fill.position.set(...STUDIO_LIGHTING.fill.position)
  const yPositive = new THREE.DirectionalLight(STUDIO_LIGHTING.yPositive.color, STUDIO_LIGHTING.yPositive.intensity)
  yPositive.position.set(...STUDIO_LIGHTING.yPositive.position)
  const rim = new THREE.DirectionalLight(STUDIO_LIGHTING.rim.color, STUDIO_LIGHTING.rim.intensity)
  rim.position.set(...STUDIO_LIGHTING.rim.position)
  scene.add(hemisphere, key, fill, yPositive, rim)
  return { hemisphere, key, fill, yPositive, rim }
}

function dot(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.max(0, a.dot(b))
}

/**
 * Analytic counterpart of the fixed WebGL studio rig for SVG/canvas previews.
 * The result is intentionally clamped: a preview must retain readable dark
 * faces, but still show enough directional contrast to explain the shape.
 */
export function studioFaceLight(normal: StorageNormal): number {
  const face = storageNormalToThree(normal)
  const keyDirection = new THREE.Vector3(...STUDIO_LIGHTING.key.position).normalize()
  const fillDirection = new THREE.Vector3(...STUDIO_LIGHTING.fill.position).normalize()
  const yPositiveDirection = new THREE.Vector3(...STUDIO_LIGHTING.yPositive.position).normalize()
  const rimDirection = new THREE.Vector3(...STUDIO_LIGHTING.rim.position).normalize()
  const value = 0.76
    + dot(face, keyDirection) * 0.13
    + dot(face, fillDirection) * 0.07
    + dot(face, yPositiveDirection) * 0.09
    + dot(face, rimDirection) * 0.03
  return THREE.MathUtils.clamp(value, STUDIO_RENDER_SETTINGS.minFaceLight, STUDIO_RENDER_SETTINGS.maxFaceLight)
}

export function studioShadeFactor(normal: StorageNormal, ao = 1): number {
  const safeAo = THREE.MathUtils.clamp(ao, 0, 1)
  const aoFactor = STUDIO_RENDER_SETTINGS.aoFloor + (1 - STUDIO_RENDER_SETTINGS.aoFloor) * safeAo
  return THREE.MathUtils.clamp(studioFaceLight(normal) * aoFactor, 0, 1.12)
}

export function studioShadeRgb(rgb: readonly [number, number, number], normal: StorageNormal, ao = 1): [number, number, number] {
  const factor = studioShadeFactor(normal, ao)
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
  ]
}

export function studioShadeHex(hex: string, normal: StorageNormal, ao = 1): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const rgb: [number, number, number] = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
  const shaded = studioShadeRgb(rgb, normal, ao)
  return `#${shaded.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

