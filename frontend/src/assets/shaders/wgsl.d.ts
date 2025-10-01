/**
 * Type declarations for WGSL shader imports
 */

declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}

// If you also import without the ?raw suffix
declare module '*.wgsl' {
  const content: string;
  export default content;
}