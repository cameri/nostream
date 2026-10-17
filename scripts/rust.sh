#!/bin/sh
# Run one cargo/rustc command in the Rust builder container.
#
# This sandbox has no Rust toolchain and its Docker policy denies attach/exec for
# non-builder containers, so the command runs as create -> start -> wait -> logs -> rm,
# exactly the shape containers/rust-builder/rb-run uses. Nothing of our own is written to
# stdout: cargo's output is the only output.
#
# Usage:
#   scripts/rust.sh cargo test --workspace
#   scripts/rust.sh cargo fmt --all --check
#   scripts/rust.sh rustc --version
#
# Environment:
#   NOSTREAM_HOST_DIR   source tree as the Docker daemon sees it. Default: this script's
#                       repository root, translated /workspace -> /home/cameri/Workspace.
#   RUST_CACHE_HOST     host cache root (default /home/cameri/Workspace/containers/rust-builder/cache)
#   RUST_BUILDER_IMAGE  image (default containers-rust-builder:latest)
set -eu

if [ "$#" -eq 0 ]; then
    echo "usage: scripts/rust.sh <command> [args...]" >&2
    exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
case "$local_root" in
    /workspace/*) default_root="/home/cameri/Workspace/${local_root#/workspace/}" ;;
    *) default_root="$local_root" ;;
esac

src_host=${NOSTREAM_HOST_DIR:-$default_root}
cache_host=${RUST_CACHE_HOST:-/home/cameri/Workspace/containers/rust-builder/cache}
image=${RUST_BUILDER_IMAGE:-containers-rust-builder:latest}

# The daemon silently creates a missing bind source as an empty directory, which then looks
# like a tree without a manifest. Check the tree from the side we can see before creating the
# container: the local path when the script runs in the sandbox, the host path when it runs
# on the host (where NOSTREAM_HOST_DIR is normally unset).
if [ -n "${NOSTREAM_HOST_DIR:-}" ]; then
    checked_root=$src_host
else
    checked_root=$local_root
fi
# The host path is invisible from inside the sandbox, so an explicit NOSTREAM_HOST_DIR does
# not prove anything here; fall back to the local tree (the bind source the script itself
# hands to the daemon) before refusing.
if [ ! -f "$checked_root/Cargo.toml" ] && [ ! -f "$local_root/Cargo.toml" ]; then
    echo "scripts/rust.sh: no Cargo.toml at $checked_root or $local_root (set NOSTREAM_HOST_DIR)" >&2
    exit 66
fi

name="rust-run-$$-$(date +%s)"
cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT HUP TERM

docker create --name "$name" --label org.testcontainers=true --user 1000:1000 \
    -e CARGO_HOME=/home/node/.cargo \
    -e RUSTUP_HOME=/home/node/.rustup \
    -e CARGO_TARGET_DIR=/target \
    -e CARGO_TERM_COLOR=never \
    -e HOME=/home/node \
    -v "$cache_host/cargo:/home/node/.cargo" \
    -v "$cache_host/rustup:/home/node/.rustup" \
    -v "$cache_host/target:/target" \
    -v "$src_host:/work/nostream" \
    "$image" bash -lc 'cd /work/nostream && exec "$@"' rust-sh "$@" >/dev/null

docker start "$name" >/dev/null
status=$(docker wait "$name")
docker logs "$name" 2>&1
exit "$status"
