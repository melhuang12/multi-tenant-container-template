# =============================================================================
# Multi-Tenant Vibe App Container
# =============================================================================
# Build: v2 - Added location tracking
#
# This Dockerfile creates the container image that runs for each tenant.
# 
# WHAT THIS CONTAINER DOES:
# - Runs a simple Node.js web server that hosts user applications
# - Serves static files from /app directory
# - Provides a basic API for health checks and app info
#
# CUSTOMIZATION:
# Replace this with your own runtime environment based on your needs:
# - Python: FROM python:3.11-slim
# - Go: FROM golang:1.21-alpine
# - Rust: FROM rust:1.75-slim
# - Or any custom image from a registry
#
# REQUIREMENTS:
# - Must listen on port 8080 (or update defaultPort in src/index.js)
# - Should respond to health checks at /health or /
# - Should handle graceful shutdown on SIGTERM
# =============================================================================

# -----------------------------------------------------------------------------
# BASE IMAGE
# -----------------------------------------------------------------------------
# Using Node.js Alpine for a small, secure base image
# Alpine Linux is ~5MB vs ~100MB for standard images
FROM node:20-alpine

# -----------------------------------------------------------------------------
# SECURITY: Run as non-root user
# -----------------------------------------------------------------------------
# Create a non-root user for security best practices
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# -----------------------------------------------------------------------------
# WORKING DIRECTORY
# -----------------------------------------------------------------------------
WORKDIR /app

# -----------------------------------------------------------------------------
# INSTALL DEPENDENCIES
# -----------------------------------------------------------------------------
# Copy package files first to leverage Docker layer caching
COPY example-app/package*.json ./

# Install production dependencies only
RUN npm ci --only=production 2>/dev/null || npm install --only=production || true

# -----------------------------------------------------------------------------
# COPY APPLICATION CODE
# -----------------------------------------------------------------------------
# Copy the example app that runs inside the container
COPY example-app/ ./

# -----------------------------------------------------------------------------
# SET OWNERSHIP
# -----------------------------------------------------------------------------
RUN chown -R appuser:appgroup /app

# -----------------------------------------------------------------------------
# SWITCH TO NON-ROOT USER
# -----------------------------------------------------------------------------
USER appuser

# -----------------------------------------------------------------------------
# EXPOSE PORT
# -----------------------------------------------------------------------------
# This must match defaultPort in your Container class
EXPOSE 8080

# -----------------------------------------------------------------------------
# HEALTH CHECK
# -----------------------------------------------------------------------------
# Docker/Cloudflare will use this to verify the container is healthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# -----------------------------------------------------------------------------
# START COMMAND
# -----------------------------------------------------------------------------
# Start the application server
CMD ["node", "server.js"]
