use pyo3::prelude::*;
use pyo3::wrap_pyfunction;
use pyo3::types::PyModule;
use pyo3::types::PyModuleMethods;

mod rust_maze_solver;

use rust_maze_solver::process_and_solve_maze;

/// A Python module implemented in Rust.
#[pymodule]
#[pyo3(name = "rust_maze_solver")]
fn rust_maze_solver_module(py: Python<'_>, module: &Bound<'_, PyModule>) -> PyResult<()> {
     // Initialize rayon's thread pool
    rayon::ThreadPoolBuilder::new()
        .num_threads(rayon::current_num_threads())
        .build_global()
        .unwrap_or_else(|e| eprintln!("Failed to build thread pool: {}", e));
    
    module.add_function(wrap_pyfunction!(process_and_solve_maze, py)?)?;

   // Add docstring
    module.add("__doc__", "Optimized maze solving implementation in Rust with parallel processing and fixed memory allocation.")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_module_initialization() {
        Python::with_gil(|py| {
            let m = PyModule::new(py, "rust_maze_solver").unwrap();
            rust_maze_solver_module(py, &m).unwrap();
            
            // Verify the function is available
            assert!(m.getattr("process_and_solve_maze").is_ok());
        });
    }
} 