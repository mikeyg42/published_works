// frontend/src/app/hex-maze/assets/js/hex-grid/index.js
// Ensure the global vg object exists (good for debugging)
if (typeof window.vg === 'undefined') {
  console.error('von-grid library not properly initialized');
}

// This file re-exports the global vg object
// Make sure it's imported after all other library files
export default window.vg || {};