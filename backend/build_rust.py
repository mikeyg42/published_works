#!/usr/bin/env python3
"""
Build script for compiling and installing the Rust maze solver
"""
import os
import sys
import subprocess
import platform
import shutil
import sysconfig
from pathlib import Path

def run_command(cmd, cwd=None, shell=False):
    """Run a command and return its output"""
    print(f"Running: {' '.join(cmd) if not shell else cmd}")
    try:
        result = subprocess.run(
            cmd, 
            cwd=cwd,
            check=True, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True,
            shell=shell
        )
        if result.stdout:
            print(result.stdout)
        return result.stdout, None
    except subprocess.CalledProcessError as e:
        print(f"Error executing command: {e}")
        print(f"STDOUT: {e.stdout}")
        print(f"STDERR: {e.stderr}")
        return None, e.stderr

def check_rust_toolchain():
    """Check if Rust and Cargo are installed"""
    _, err = run_command(["rustc", "--version"])
    if err:
        print("Rust is not installed or not in PATH")
        print("Please install Rust from https://rustup.rs/")
        return False
    
    _, err = run_command(["cargo", "--version"])
    if err:
        print("Cargo is not installed or not in PATH")
        print("Please install Rust from https://rustup.rs/")
        return False
    
    return True

def get_python_info():
    """Get Python configuration"""
    print("\nPython Configuration:")
    print(f"Executable: {sys.executable}")
    print(f"Version: {sys.version}")
    print(f"Include path: {sysconfig.get_path('include')}")
    print(f"Library path: {sysconfig.get_config_var('LIBDIR')}")
    
    # Print all config vars for debugging
    print("\nSelected sysconfig variables:")
    for key in ['INCLUDEPY', 'BINDIR', 'LIBDIR', 'PYTHONFRAMEWORK', 'MULTIARCH']:
        print(f"  {key}: {sysconfig.get_config_var(key)}")
    
    return {
        'executable': sys.executable,
        'include': sysconfig.get_path('include'),
        'lib': sysconfig.get_config_var('LIBDIR'),
    }

def build_rust_module():
    """
    Build the Rust module for maze solving using either a shell script
    or direct cargo commands.
    """
    print("Building Rust maze solver module...")
    
    # Get the directory where this script resides
    script_dir = Path(__file__).resolve().parent
    rust_dir = script_dir / "rust"
    
    # Ensure we're in the rust directory for the build
    os.chdir(rust_dir)
    
    # Set Python environment variable to current Python interpreter
    env = os.environ.copy()
    env["PYTHON_SYS_EXECUTABLE"] = sys.executable
    
    try:
        # First try the shell script approach
        if platform.system() == "Windows":
            # On Windows, use the bat file
            script_path = "build_with_python.bat"
            if os.path.exists(script_path):
                result = subprocess.run(script_path, shell=True, check=True, env=env)
            else:
                raise FileNotFoundError(f"Build script {script_path} not found")
        else:
            # On Unix systems, use the shell script
            script_path = "./build_with_python.sh"
            if os.path.exists(script_path):
                result = subprocess.run(["bash", script_path], check=True, env=env)
            else:
                raise FileNotFoundError(f"Build script {script_path} not found")
        
        # Verify the module was created
        output_path = script_dir / "rust_maze_solver.so"
        if not output_path.exists():
            raise FileNotFoundError(f"Expected output file {output_path} not found")
        
        print(f"Successfully built Rust module: {output_path}")
        return True
    
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"Failed to build Rust module using shell script: {e}")
        return False

def test_import():
    """Test importing the built module"""
    print("\nTesting import of rust_maze_solver module...")
    try:
        # Ensure current directory is in path
        script_dir = os.path.dirname(os.path.abspath(__file__))
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
            
        # First check if module exists on disk
        potential_extensions = ['.so', '.pyd', '.dll', '.dylib']
        module_name = "rust_maze_solver"
        found_files = []
        
        for ext in potential_extensions:
            module_path = os.path.join(script_dir, module_name + ext)
            if os.path.exists(module_path):
                found_files.append(module_path)
                
        if not found_files:
            print(f"No module files found in {script_dir}")
            print(f"Looked for: {[module_name + ext for ext in potential_extensions]}")
            return False
            
        print(f"Found these module files: {found_files}")
        
        # Now try importing
        import importlib
        try:
            solver = importlib.import_module("rust_maze_solver")
            print("✅ Rust solver module found!")
            
            if hasattr(solver, "process_and_solve_maze"):
                print("✅ process_and_solve_maze function found in the Rust module")
                return True
            else:
                print("❌ process_and_solve_maze function NOT found in the Rust module")
                print(f"Available attributes: {dir(solver)}")
                return False
                
        except ImportError as e:
            print(f"❌ Could not import rust_maze_solver: {e}")
            print("Testing for other similarly named modules...")
            
            import pkgutil
            all_modules = [m.name for m in pkgutil.iter_modules()]
            relevant_modules = [m for m in all_modules if 'maze' in m or 'rust' in m or 'solver' in m]
            
            if relevant_modules:
                print(f"Found potentially relevant modules: {relevant_modules}")
            else:
                print("No relevant modules found")
                
            return False
    except Exception as e:
        print(f"❌ Error testing import: {type(e).__name__}: {e}")
        return False

def main():
    """Main function"""
    print("=" * 50)
    print("Building Rust maze solver module")
    print("=" * 50)
    
    # Print Python info
    python_info = get_python_info()
    
    if not check_rust_toolchain():
        return 1
    
    if not build_rust_module():
        return 1
    
    if not test_import():
        print("\nFailed to import module after building.")
        print("You may need to restart your Python interpreter or server.")
        return 1
    
    print("\nBuild and import successful!")
    return 0

if __name__ == "__main__":
    sys.exit(main()) 