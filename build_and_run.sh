#!/bin/bash
# build_and_run.sh
cd /Users/mikeglendinning/projects/maze_solver_app/

# Build Rust library
cd backend/rust
maturin develop --release
cd ../..

# Install Python package in development mode
pip install -e .

# Run the server
python -m uvicorn backend.main:app --reload