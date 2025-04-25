# Stage 1: Build the Rust wheel and install dependencies
# Use a specific Python version matching the final stage, based on Bookworm
FROM python:3.12-bookworm as builder
WORKDIR /app

# Install Rust using rustup for better control and consistency
# Combined apt-get install onto a single line to avoid parser issues in Cloud Build
RUN apt-get update && apt-get install -y --no-install-recommends curl build-essential pkg-config openssl libssl-dev && rm -rf /var/lib/apt/lists/*

# Explicitly upgrade zlib1g to the fixed version if available
RUN apt-get install -y --only-upgrade zlib1g && \
    rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Python build tools
RUN pip install --no-cache-dir --upgrade pip wheel setuptools
# Install Maturin
RUN pip install --no-cache-dir maturin

# Copy only necessary files for building the Rust component first
# Ensure the entire backend/rust directory structure is copied correctly
COPY backend/rust/ ./backend/rust/
COPY pyproject.toml ./

# Build the Rust wheel
# Target the specific Python version for compatibility
RUN cd backend/rust && maturin build --release -o /wheels --interpreter python3.12

# --- Build Python dependencies ---
# Copy the rest of the application code
COPY . .

# Create and activate virtual environment (optional but good practice)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip in venv
RUN pip install --no-cache-dir --upgrade pip

# Install the built Rust wheel first
RUN pip install --no-cache-dir /wheels/*.whl

# Install Python dependencies from requirements or pyproject.toml
# Using pyproject.toml directly is cleaner if possible
# Ensure all runtime dependencies are listed in pyproject.toml [project].dependencies
# If you have a requirements.txt, use: RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir . # Installs package defined in pyproject.toml and its deps

# --- Stage 2: Runtime image ---
# Use the slim version for a smaller footprint
FROM python:3.12-slim-bookworm
WORKDIR /app

# Install only essential runtime system dependencies
# If your Rust code needs specific .so files, add them here
# Use ldd on the .so file in the builder stage to check
RUN apt-get update && \
    apt-get install -y --no-install-recommends && \
    # Explicitly upgrade zlib1g to the fixed version if available
    apt-get install -y --only-upgrade zlib1g && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user for security
RUN useradd --create-home appuser
USER appuser
WORKDIR /home/appuser/app

# Copy virtual environment from builder stage (includes all dependencies)
COPY --from=builder /opt/venv /opt/venv

# Copy the application code needed at runtime
# Adjust this to copy only what's necessary (e.g., the 'backend' directory)
COPY --from=builder --chown=appuser:appuser /app/backend ./backend

# Activate virtual environment
ENV PATH="/opt/venv/bin:$PATH"
# Set environment variables for Cloud Run (PORT is set by Cloud Run itself)
# ENV PORT=8080 # Cloud Run injects this, setting it here is redundant but harmless
ENV HOST=0.0.0.0
# Be cautious with CORS_ORIGINS in ENV, consider config files or secrets
ENV CORS_ORIGINS="https://michaelglendinning.com"

# Expose the port (informational)
EXPOSE 8080

# Command to run the application
# Use the Python executable from the virtual environment
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
