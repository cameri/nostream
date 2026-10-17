//! `nostream-cli` — the operator command line.
//!
//! `anyhow` is allowed here (binaries only, spec D10); every subcommand handler lives in the
//! library so the error model stays typed.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use nostream_cli::config::CommandOutput;
use nostream_cli::{CliError, commands};

#[derive(Debug, Parser)]
#[command(name = "nostream-cli", about = "Operate a nostream relay")]
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
    /// Import events from a file.
    Import,
    /// Print the relay's NIP-11 info.
    Info,
    /// Mint and manage invite codes.
    Invite,
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
        Command::Import => commands::import::run().map(|_| CommandOutput::default()),
        Command::Info => commands::info::run().map(|_| CommandOutput::default()),
        Command::Invite => commands::invite::run().map(|_| CommandOutput::default()),
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
    }
}
