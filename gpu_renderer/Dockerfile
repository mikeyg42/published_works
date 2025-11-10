# GPU Renderer Dockerfile for Google Cloud Run with T4 GPU support
FROM ubuntu:22.04

# Set non-interactive mode for apt
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies including Vulkan support
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy Cargo files and source
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Build the release binary
RUN cargo build --release

# Set environment variables for headless GPU operation
ENV DISPLAY=:99
ENV WGPU_BACKEND=vulkan

# Expose port for potential HTTP interface (optional)
EXPOSE 8080

# Create directory for output
RUN mkdir -p /app/output

# Set the binary as entrypoint
CMD ["./target/release/maze-gpu-renderer"]