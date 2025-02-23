use pyo3::prelude::*;
use pyo3::wrap_pyfunction;
use pyo3::types::PyModule;
use pyo3::types::PyModuleMethods;

mod rust_maze_solver;

use rust_maze_solver::{find_longest_path, find_longest_paths, async_process_maze};

/// A Python module implemented in Rust.
/// 
/// 
#[pymodule]
#[pyo3(name = "maze_solver")]
fn maze_solver(_py: Python<'_>, module: &Bound<'_, PyModule>) -> PyResult<()> {
     // Initialize rayon's thread pool
    rayon::ThreadPoolBuilder::new()
        .num_threads(rayon::current_num_threads())
        .build_global()
        .unwrap();

    module.add_function(wrap_pyfunction!(find_longest_path, module)?)?;
    module.add_function(wrap_pyfunction!(find_longest_paths, module)?)?;
    module.add_function(wrap_pyfunction!(async_process_maze, module)?)?;

   // Add docstring
    module.add("__doc__", "Fast maze solving implementation in Rust with parallel processing capabilities.")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_module_initialization() {
        Python::with_gil(|py| {
            let m = PyModule::new(py, "rust_maze_solver").unwrap();
            maze_solver(py, &m).unwrap();
            
            // Verify the functions are available
            assert!(m.getattr("find_longest_paths").is_ok());
            assert!(m.getattr("find_longest_path").is_ok());
        });
    }
}