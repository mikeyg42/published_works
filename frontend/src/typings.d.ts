// src/typings.d.ts
declare namespace vg {
  const HEX: string;
  const SQRT3: number;
  const PI: number;
  const TAU: number;
  const DEG_TO_RAD: number;
  const TILE: string;
  
  namespace Loader {
    function init(): void;
    function loadTexture(url: string): any;
  }
  
  class Scene {
    constructor(config: any, controlsConfig?: any);
    add(object: any): void;
    render(): void;
    container: THREE.Scene;
    camera: THREE.Camera;
    renderer: THREE.WebGLRenderer;
    controls: any;
  }
  
  class HexGrid {
    constructor(config?: any);
    cellToPixel(cell: any): any;
    pixelToCell(pos: any): any;
    cellToHash(cell: any): string;
    add(cell: any): any;
    remove(cell: any): void;
    dispose(): void;
    cellSize: number;
    cells: Record<string, any>;
    _cellWidth: number;
    _cellLength: number;
  }
  
  class Board {
    constructor(grid: any, config?: any);
    reset(): void;
    generateTilemap(config?: any): any[];
    group: THREE.Group;
    tiles: any[];
  }
  
  class Cell {
    constructor(q?: number, r?: number, s?: number, h?: number);
    q: number;
    r: number;
    s: number;
    h: number;
    walkable: boolean;
    userData: any;
  }
  
  class Tile {
    constructor(config: any);
    dispose(): void;
    mesh: THREE.Mesh;
    position: THREE.Vector3;
  }
  
  namespace Tools {
    function randomInt(min: number, max: number): number;
  }
}

// Add this declaration for the vg (von-grid) library
declare var vg: any;