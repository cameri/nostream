//! `nostream-cli` — the operator command line.
//!
//! `anyhow` is allowed here (binaries only, spec D10); every subcommand handler lives in the
//! library so the error model stays typed.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use nostream_cli::config::CommandOutput;
use nostream_cli::{CliError, commands};

// `import` parses its own arguments, so clap's `help` subcommand would render a second,
// contradictory page for it; `--help` is the single help surface.
#[derive(Debug, Parser)]
#[command(
    name = "nostream-cli",
    about = "Operate a nostream relay",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect and validate the effective settings.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Drive the local development loop.
    Dev,
    /// Export events to a file.
    Export,
    /// Import events from a .jsonl or .json file.
    #[command(disable_help_flag = true)]
    Import {
        /// The command's own arguments, parsed by the command (see its help).
        #[arg(
            value_name = "ARGS",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
    /// Print the relay's NIP-11 info.
    Info,
    /// Mint and manage invite codes.
    Invite,
    /// Copy the Postgres store into an LMDB store.
    Migrate {
        #[command(subcommand)]
        command: MigrateCommand,
    },
    /// Seed the database.
    Seed,
    /// Run the first-time setup flow.
    Setup,
    /// Start the relay stack.
    Start,
    /// Stop the relay stack.
    Stop,
    /// Update the deployment.
    Update,
    /// Run the interactive settings editor.
    Tui,
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Validate the effective settings and print one `path: message` line per issue.
    Validate {
        /// The configuration directory (overrides NOSTR_CONFIG_DIR).
        #[arg(long)]
        config_dir: Option<PathBuf>,
        /// Validate this file instead of the configured settings.
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Print the effective value at a dot-path.
    Get {
        /// The dot-path to read (for example `info.relay_url`).
        path: String,
        /// The configuration directory (overrides NOSTR_CONFIG_DIR).
        #[arg(long)]
        config_dir: Option<PathBuf>,
        /// Print the value as JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum MigrateCommand {
    /// Copy every table from Postgres into an LMDB store, with the relay stopped.
    ///
    /// The source is Postgres from `DB_URI`, else the `DB_*` parts. The target is a store root:
    /// the environment is `<DIR>/lmdb` and the manifest `<DIR>/migration-manifest.json`.
    ///
    /// The first connection to the source is bounded at ten seconds whatever
    /// `DB_ACQUIRE_CONNECTION_TIMEOUT` says: a mistyped host is reported at once with the
    /// driver's reason, not after the pool's minute.
    ///
    /// A re-run resumes where the manifest says the last one stopped. Deleting
    /// `<DIR>/migration-manifest.json` does not restart a half-filled store: a store that holds
    /// rows and no manifest is refused, so starting over takes a fresh `--target`, or the
    /// manifest and the store removed together. Nothing may write to either store while a run
    /// is in progress, so the relay must be stopped on both before the first batch is read.
    PgToLmdb {
        /// The store root (the environment lives under `<DIR>/lmdb`).
        #[arg(long, value_name = "DIR")]
        target: PathBuf,
        /// Rows per batch, and the page size verify reads with.
        #[arg(
            long,
            value_name = "N",
            default_value_t = 1_000,
            value_parser = clap::builder::RangedU64ValueParser::<usize>::new().range(1..)
        )]
        batch_size: usize,
        /// Verify the store against its manifest and copy nothing.
        #[arg(long)]
        verify: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let result = match cli.command {
        Command::Config { command } => match command {
            ConfigCommand::Validate { config_dir, config } => {
                commands::config::validate(&cwd, config_dir.as_deref(), config.as_deref())
            }
            ConfigCommand::Get {
                path,
                config_dir,
                json,
            } => commands::config::get(&cwd, config_dir.as_deref(), &path, json),
        },
        Command::Dev => commands::dev::run().map(|_| CommandOutput::default()),
        Command::Export => commands::export::run().map(|_| CommandOutput::default()),
        Command::Import { args } => {
            let mut stdout = std::io::stdout().lock();
            commands::import::run(&args, &cwd, &mut stdout)
        }
        Command::Info => commands::info::run().map(|_| CommandOutput::default()),
        Command::Invite => commands::invite::run().map(|_| CommandOutput::default()),
        Command::Migrate { command } => match command {
            MigrateCommand::PgToLmdb {
                target,
                batch_size,
                verify,
            } => {
                let options = commands::migrate::MigrateOptions {
                    target,
                    batch_size,
                    verify,
                };
                let mut stdout = std::io::stdout().lock();
                commands::migrate::run(options, &mut stdout)
            }
        },
        Command::Seed => commands::seed::run().map(|_| CommandOutput::default()),
        Command::Setup => commands::setup::run().map(|_| CommandOutput::default()),
        Command::Start => commands::start::run().map(|_| CommandOutput::default()),
        Command::Stop => commands::stop::run().map(|_| CommandOutput::default()),
        Command::Update => commands::update::run().map(|_| CommandOutput::default()),
        Command::Tui => nostream_cli::tui::run().map(|_| CommandOutput::default()),
    };

    match result {
        Ok(output) => {
            for line in &output.lines {
                println!("{line}");
            }
            output.exit_code()
        }
        Err(CliError::NotImplemented { module }) => {
            eprintln!("not implemented in Phase 1 (job 005): {module}");
            ExitCode::from(1)
        }
        Err(CliError::Config(message)) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
        Err(CliError::Import(message)) => {
            eprintln!("Import failed: {message}");
            ExitCode::from(1)
        }
        Err(CliError::Migrate(message)) => {
            eprintln!("Migration failed: {message}");
            ExitCode::from(1)
        }
    }
}
