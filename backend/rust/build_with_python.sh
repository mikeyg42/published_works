#!/bin/bash
# This script helps build the Rust module with the correct Python configuration

# Exit on error
set -e

# Debug info
echo "Building Rust module with Python integration"
echo "Current directory: $(pwd)"

# Get Python executable
if [ -n "$PYTHON_SYS_EXECUTABLE" ]; then
    PYTHON_EXECUTABLE="$PYTHON_SYS_EXECUTABLE"
else
    PYTHON_EXECUTABLE=$(which python3)
fi
echo "Using Python executable: $PYTHON_EXECUTABLE"

# Get Python include path
PYTHON_INCLUDE=$($PYTHON_EXECUTABLE -c "import sysconfig; print(sysconfig.get_path('include'))")
echo "Python include path: $PYTHON_INCLUDE"

# Get Python library path and version
PYTHON_VERSION=$($PYTHON_EXECUTABLE -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_LIB_PATH=$($PYTHON_EXECUTABLE -c "import sysconfig; print(sysconfig.get_config_var('LIBDIR'))")
PYTHON_FRAMEWORK_PATH=$($PYTHON_EXECUTABLE -c "import sys, os; print(os.path.dirname(os.path.dirname(sys.executable)))")
PYTHON_LIB="python${PYTHON_VERSION}"
echo "Python version: $PYTHON_VERSION"
echo "Python library path: $PYTHON_LIB_PATH"
echo "Python library name: $PYTHON_LIB"

# Platform-specific settings
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Building on macOS"
    # Check for Homebrew Python
    if [[ -d "/opt/homebrew/Frameworks/Python.framework" ]]; then
        echo "Found Homebrew Python framework"
        export LIBRARY_PATH="$LIBRARY_PATH:$PYTHON_LIB_PATH:/opt/homebrew/Frameworks/Python.framework/Versions/Current/lib"
        export DYLD_LIBRARY_PATH="$DYLD_LIBRARY_PATH:$PYTHON_LIB_PATH:/opt/homebrew/Frameworks/Python.framework/Versions/Current/lib"
    fi
    
    # Check for system Python framework
    if [[ -d "/Library/Frameworks/Python.framework" ]]; then
        echo "Found system Python framework"
        export LIBRARY_PATH="$LIBRARY_PATH:$PYTHON_LIB_PATH:/Library/Frameworks/Python.framework/Versions/Current/lib"
        export DYLD_LIBRARY_PATH="$DYLD_LIBRARY_PATH:$PYTHON_LIB_PATH:/Library/Frameworks/Python.framework/Versions/Current/lib"
    fi
    
    # Check virtual environment
    if [ -n "$VIRTUAL_ENV" ]; then
        echo "Found virtual environment at $VIRTUAL_ENV"
        export LIBRARY_PATH="$LIBRARY_PATH:$VIRTUAL_ENV/lib"
        export DYLD_LIBRARY_PATH="$DYLD_LIBRARY_PATH:$VIRTUAL_ENV/lib"
    fi
    
    # Create a custom linker script to help with Python library linking
    echo '#!/bin/bash
clang "$@" -undefined dynamic_lookup
' > rust_linker.sh
    chmod +x rust_linker.sh
    
    # Build with extended library paths and debug output
    echo "Building with cargo..."
    cargo build --release -vv
    
    # Copy the compiled library to the correct location
    echo "Copying library to output location..."
    if [[ -f "target/release/librust_maze_solver.dylib" ]]; then
        cp target/release/librust_maze_solver.dylib ../rust_maze_solver.so
    else
        # Try alternate location
        if [[ -f "../target/release/librust_maze_solver.dylib" ]]; then
            cp ../target/release/librust_maze_solver.dylib ../rust_maze_solver.so
        else 
            # Search for the file
            DYLIB_PATH=$(find /Users/mikeglendinning/projects/maze_solver_app -name "librust_maze_solver.dylib" | head -1)
            if [ -n "$DYLIB_PATH" ]; then
                echo "Found library at: $DYLIB_PATH"
                cp "$DYLIB_PATH" ../rust_maze_solver.so
            else
                echo "ERROR: Could not find the compiled library"
                exit 1
            fi
        fi
    fi
    
else
    # Linux settings
    echo "Building on Linux"
    cargo build --release
    cp target/release/librust_maze_solver.so ../rust_maze_solver.so
fi

echo "Build completed successfully"
python -c "import rust_maze_solver; print('Successfully imported rust_maze_solver module!')" 