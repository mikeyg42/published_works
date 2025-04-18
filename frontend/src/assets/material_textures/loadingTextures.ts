//loadingTextures.ts
import * as THREE from 'three';

// Define the interface for a complete PBR texture set.
export interface TextureSet {
  albedo: THREE.Texture | null;
  normal: THREE.Texture | null;
  metallic: THREE.Texture | null;
  roughness: THREE.Texture | null;
  ao: THREE.Texture | null;
  height: THREE.Texture | null;
  loaded: boolean;
  material?: THREE.MeshStandardMaterial;
  mesh?: THREE.Mesh;
}

// Interface for file names.
interface TextureFileNames {
  albedo: string;
  normal: string;
  metallic: string;
  roughness: string;
  ao: string;
  height: string;
}

// Registry to store different material sets.
const materials: Record<string, TextureSet> = {};

/**
 * Loads a complete set of PBR textures from a folder.
 * Uses default naming conventions unless overridden.
 *
 * @param materialName The key name for this material (e.g. 'bronze')
 * @param basePath The folder path where texture images are stored.
 * @param onComplete Optional callback once all textures are loaded and material is created.
 */
export function loadTextureSet(
  materialName: string,
  basePath: string,
  onComplete?: (textureSet: TextureSet) => void
): Promise<TextureSet> {
  return new Promise((resolve, reject) => {
    // Initialize the registry for this material.
    materials[materialName] = {
      albedo: null,
      normal: null,
      metallic: null,
      roughness: null,
      ao: null,
      height: null,
      loaded: false,
      material: undefined,
      mesh: undefined
    };

    // Default file names
    const defaults: TextureFileNames = {
      albedo: `${materialName}_albedo.png`,
      normal: `${materialName}_normal-ogl.png`,
      metallic: `${materialName}_metallic.png`,
      roughness: `${materialName}_roughness.png`,
      ao: `${materialName}_ao.png`,
      height: `${materialName}_height.png`
    };

    const names: TextureFileNames = Object.assign({}, defaults);
    const textureTypes: (keyof Omit<TextureSet, 'loaded' | 'material' | 'mesh'>)[] = [
      'albedo', 'normal', 'metallic', 'roughness', 'ao', 'height'
    ];
    let loadedCount = 0;
    const totalMaps = textureTypes.length;

    // Helper to check if all textures are loaded.
    function checkAllLoaded(): void {
      loadedCount++;
      if (loadedCount === totalMaps) {
        materials[materialName].loaded = true;
        // Create the material from the texture set.
        createMaterial(materialName);
        if (onComplete) {
          onComplete(materials[materialName]);
        }
        resolve(materials[materialName]);
      }
    }

    // Load each texture via vg.Loader.
    textureTypes.forEach((type) => {
      const path = `${basePath}/${names[type]}`;
      // Use THREE.UVMapping as the default mapping.
      window.vg.Loader.loadTexture(
        path,
        THREE.UVMapping,
        function (texture: THREE.Texture): void {
          materials[materialName][type] = texture;
          checkAllLoaded();
        },
        function (error: any): void {
          console.error(`Error loading ${type} map for ${materialName}:`, error);
          // Even on error, count as loaded so that onComplete eventually fires.
          checkAllLoaded();
        }
      );
    });
  });
}

/**
 * Creates a THREE.MeshStandardMaterial from a loaded texture set.
 * Optional parameters can override displacementScale, metalness, and roughness.
 *
 * @param materialName The key name for this material set.
 * @param options Optional parameters.
 * @returns The created material or null.
 */
export function createMaterial(
  materialName: string,
  options: Partial<{ displacementScale: number; metalness: number; roughness: number }> = {}
) {
  const textureSet = materials[materialName];
  if (!textureSet || !textureSet.loaded) {
    console.error(`Material ${materialName} not loaded or does not exist.`);
    return null;
  }

  const mat = new THREE.MeshStandardMaterial({
    map: textureSet.albedo || undefined,
    normalMap: textureSet.normal || undefined,
    metalnessMap: textureSet.metallic || undefined,
    roughnessMap: textureSet.roughness || undefined,
    aoMap: textureSet.ao || undefined,
    displacementMap: textureSet.height || undefined,
    displacementScale: options.displacementScale !== undefined ? options.displacementScale : 0.05,
    metalness: options.metalness !== undefined ? options.metalness : 0.5, // Default value
    roughness: options.roughness !== undefined ? options.roughness : 0.5  // Default value
  });

  textureSet.material = mat;
  console.log(`Material ${materialName} created successfully.`);
  return mat;
}

/**
 * Creates a mesh using the material previously created for the given material name.
 * A default geometry (BoxGeometry) is used if none is provided.
 *
 * @param materialName The material key to use.
 * @param geometry Optional custom geometry.
 * @returns The created mesh or null.
 */
export function createMesh(
  materialName: string, 
  geometry?: THREE.BufferGeometry
): THREE.Mesh | null {
  const textureSet = materials[materialName];
  if (!textureSet || !textureSet.material) {
    console.error(`Material ${materialName} not available.`);
    return null;
  }

  const geo = geometry || new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geo, textureSet.material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  textureSet.mesh = mesh;
  return mesh;
}

/**
 * Returns the texture set for a given material name.
 *
 * @param materialName The material key.
 * @returns The texture set or null.
 */
export function getTextureSet(materialName: string): TextureSet | null {
  if (!materials[materialName]) {
    console.error(`Material ${materialName} not found.`);
    return null;
  }
  return materials[materialName];
}

/**
 * Returns the created THREE.MeshStandardMaterial for a given material name.
 *
 * @param materialName The material key.
 * @returns The material or null.
 */
export function getMaterial(materialName: string): THREE.MeshStandardMaterial | null {
  const textureSet = materials[materialName];
  if (!textureSet || !textureSet.material) {
    console.error(`Material ${materialName} not created yet.`);
    return null;
  }
  return textureSet.material;
}

/**
 * Returns the created mesh (if any) for a given material name.
 *
 * @param materialName The material key.
 * @returns The mesh or null.
 */
export function getMesh(materialName: string): THREE.Mesh | null {
  const textureSet = materials[materialName];
  if (!textureSet || !textureSet.mesh) {
    console.error(`Mesh for ${materialName} not created yet.`);
    return null;
  }
  return textureSet.mesh;
}

/**
 * Initializes the loader.
 * Should be called early in your app (for example, during scene initialization).
 *
 * @param crossOrigin Optional crossOrigin flag.
 */
export function initLoader(crossOrigin?: boolean): void {
  if (!window.vg?.Loader?.init) {
    throw new Error('vg.Loader not available. Make sure your vg library is loaded.');
  }
  window.vg.Loader.init(crossOrigin);
}
