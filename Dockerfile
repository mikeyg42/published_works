# Stage 1: Build the Rust wheel and install dependencies
# Use a specific Python version matching the final stage, based on Bookworm
FROM python:3.12-bookworm as builder
WORKDIR /app

# Install Rust and Node.js using rustup and NodeSource for better control and consistency
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl build-essential pkg-config openssl libssl-dev ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# Install Node.js 18.x LTS
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# Explicitly upgrade zlib1g to the fixed version if available
RUN apt-get install -y --only-upgrade zlib1g \
 && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Python build tools & Maturin
RUN pip install --no-cache-dir --upgrade pip wheel setuptools maturin

# Copy only the Rust source and pyproject metadata, then build the wheel
COPY backend/rust/ ./backend/rust/
COPY pyproject.toml ./
RUN cd backend/rust \
 && maturin build --release -o /wheels --interpreter python3.12

# ─── Python deps & application install ───────────────────────────────
# Create and activate a virtualenv for all Python installs
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip inside venv
RUN pip install --no-cache-dir --upgrade pip

# Install the freshly built Rust wheel into venv
RUN pip install --no-cache-dir /wheels/*.whl

# Copy only requirements first, install direct Python deps (including redis)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Node.js dependencies for maze generation
COPY backend/maze_generation_ts/package.json ./backend/maze_generation_ts/
RUN cd backend/maze_generation_ts && npm install

# Now copy the rest of your app sources and install the package itself
COPY . .
RUN pip install --no-cache-dir .

# # stage 1b: dev only, to check if we need any additional OS-level libs for the Rust extension
# FROM python:3.12-slim-bookworm AS inspect
# WORKDIR /app
# # install nothing but ldd (comes in libc-bin) and pip
# RUN apt-get update && \
#     apt-get install -y --no-install-recommends libc-bin && \
#     rm -rf /var/lib/apt/lists/*
# COPY --from=builder /wheels/*.whl /wheels/
# 
# RUN echo "wheels directory contains:" && ls -l /wheels
# 
# RUN pip install /wheels/*.whl
# # this prints all linked libs and flags any "not found"
# RUN so=$(find "$(python3 -c 'import site; print(site.getsitepackages()[0])')" \
#               -name '*.so' -print -quit) \
#  && echo "Inspecting: $so" \
#  && ldd "$so"

# Stage 2: Runtime image
FROM python:3.12-slim-bookworm
WORKDIR /home/appuser/app

# Install Node.js runtime for TypeScript maze generation
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --create-home appuser
USER appuser

# Copy venv (with all Python & Rust deps) and your backend code
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=appuser:appuser /app/backend ./backend
COPY --from=builder --chown=appuser:appuser /app/redis_cache ./redis_cache

# Activate venv
ENV PATH="/opt/venv/bin:$PATH"
ENV HOST=0.0.0.0
ENV CORS_ORIGINS="https://michaelglendinning.com"
ENV ENVIRONMENT="production"

EXPOSE 8080

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
