FROM mcr.microsoft.com/devcontainers/base:2.2.5-trixie

# Base image already ships gcc, libc6-dev, libgomp1, make.

# uv + uv-managed Python (prebuilt), installed system-wide so it's baked into the image
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_PYTHON=3.13
RUN uv python install --default 3.13 \
    && chmod -R a+rX /opt/uv
