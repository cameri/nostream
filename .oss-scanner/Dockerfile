# Build environment for anthropics/oss-scanner.
#
# The scanner builds this image with network access, then audits it with none, so
# every crate must be fetched here. Only the Rust workspace is built: the
# TypeScript app at `src/` and `website/` is the previous implementation and is
# out of scope (see threat_model.md).

FROM rust:1.99.1-slim-bookworm

# heed links LMDB's C sources through `cc`; rustls means no libssl is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential clang pkg-config ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /code

COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
# `resources/default-settings.yaml` is read at *runtime* by the config tests, via
# `CARGO_MANIFEST_DIR/../../resources`, which is `/code/resources` here. `--no-run`
# compiles those tests without executing them, so a missing file fails the offline
# audit phase rather than the build. Nothing else under `resources/` is loaded by
# the Rust workspace; the admin and css assets belong to the TypeScript app.
COPY resources/default-settings.yaml ./resources/default-settings.yaml

RUN cargo fetch

# Compile the test binaries during setup, so the offline audit phase only runs them.
RUN cargo test --workspace --all-features --no-run

# The store and every test use local temporary directories; the Postgres parity
# targets are `#[ignore]`d and need no server.
CMD ["cargo", "test", "--workspace", "--all-features", "--offline"]
