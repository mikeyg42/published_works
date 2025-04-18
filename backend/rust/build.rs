fn main() {
    // Tell cargo to invalidate the built crate whenever the wrapper changes
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/rust_maze_solver.rs");

    // Use pyo3-build-config to configure everything
    pyo3_build_config::add_extension_module_link_args();

    // If on macOS, add dynamic lookup for symbols
    if cfg!(target_os = "macos") {
        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
    }
} 