//! The surface: the pre-parse, the hand-written top-level page, the dispatch and the renderer.
//!
//! The capture's entry point answers `--help`/`-h` and an empty command line with the page on
//! stdout at exit 0, `-v`/`--version` with the version page, and an unknown first word with
//! `Unknown command: <word>` on stderr plus the page on stdout at exit 2, and only then hands the
//! arguments to its parser (`src/cli/index.ts:470-531`). A port built on clap repeats that order
//! here, so the parser never sees a case that has its own answer (R1, C1).
//!
//! Everything a command needs from the process it runs in is one [`Context`]: the working
//! directory its files resolve against, the environment with the `.env` layer behind it, and the
//! runtime its futures run on.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::commands;
use crate::config::CommandOutput;
use crate::env_file::Environment;
use crate::error::CliError;

/// The program name every page and every error message carries (R4).
const PROGRAM: &str = "nostream";

/// What a command needs from the process it runs in.
pub struct Context {
    /// The working directory the command resolves its files against — `resources/`, `seeds/`,
    /// the compose overlays and `.env` are all read relative to it, exactly as the capture's
    /// `getProjectPath` reads them.
    pub cwd: PathBuf,
    /// The process environment with the `.env` layer behind it (`src/cli/utils/env-config.ts`).
    pub env: Environment,
    runtime: tokio::runtime::Runtime,
}

impl Context {
    /// A context for the process's own working directory.
    pub fn new() -> Result<Self, CliError> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::at(cwd)
    }

    /// A context for `cwd`, which a test names.
    pub fn at(cwd: PathBuf) -> Result<Self, CliError> {
        let env = Environment::load(&cwd);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| CliError::command(format!("unable to start a runtime: {error}")))?;
        Ok(Self { cwd, env, runtime })
    }

    /// Drives one command's future to completion on the context's runtime.
    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }
}

/// The version page (V44): `nostream/<CARGO_PKG_VERSION>`, the crate's own version — the same
/// string `info` prints as `Nostream v<version>` and the admin diagnostics serve.
pub fn version_line() -> String {
    format!("nostream/{}", env!("CARGO_PKG_VERSION"))
}

/// The top-level page, on stdout, at exit 0.
///
/// It is the capture's `cac` page (V2) with two edits, both from the removal of `dev` (R17): the
/// `  dev [...args]` row and the footer's `  $ nostream dev --help` line are gone. The version
/// line is the crate's own (R2).
pub fn page_lines() -> Vec<String> {
    [
        version_line(),
        String::new(),
        "Usage:".to_owned(),
        "  $ nostream <command> [options]".to_owned(),
        String::new(),
        "Commands:".to_owned(),
        "  start [...args]            Start Nostream (Docker Compose)".to_owned(),
        "  stop [...args]             Stop Nostream".to_owned(),
        "  info                       Show relay/runtime info".to_owned(),
        "  update [...args]           Pull latest git changes and restart relay".to_owned(),
        "  clean                      Clean Docker resources (legacy script replacement)"
            .to_owned(),
        "  import [file] [...args]    Import events from .jsonl or .json".to_owned(),
        "  export [output] [...args]  Export events to file".to_owned(),
        "  seed                       Seed relay with test data".to_owned(),
        "  invite [...args]           Mint NIP-43 invite codes".to_owned(),
        "  setup                      Initial interactive setup".to_owned(),
        "  config [...args]           Manage settings".to_owned(),
        String::new(),
        "For more info, run any command with the `--help` flag:".to_owned(),
        "  $ nostream start --help".to_owned(),
        "  $ nostream stop --help".to_owned(),
        "  $ nostream info --help".to_owned(),
        "  $ nostream update --help".to_owned(),
        "  $ nostream clean --help".to_owned(),
        "  $ nostream import --help".to_owned(),
        "  $ nostream export --help".to_owned(),
        "  $ nostream seed --help".to_owned(),
        "  $ nostream invite --help".to_owned(),
        "  $ nostream setup --help".to_owned(),
        "  $ nostream config --help".to_owned(),
        String::new(),
        "Options:".to_owned(),
        "  -h, --help     Display this message".to_owned(),
        "  -v, --version  Display version number".to_owned(),
    ]
    .to_vec()
}

/// What the pre-parse decided before the argument parser sees anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// `-h`, `--help`, or no arguments at all: the page, on stdout, at exit 0.
    Help,
    /// `-v` or `--version`: the version page, on stdout, at exit 0.
    Version,
    /// A top-level command the parser reads.
    Command,
    /// A word that is no command: `Unknown command: <word>`, at exit 2.
    Unknown(String),
}

/// The top-level words, in the page's order. A word not here is the capture's unknown command
/// (`src/cli/index.ts:514-518`), which is answered before the parser runs.
pub const COMMANDS: &[&str] = &[
    "clean-db", "config", "export", "import", "info", "invite", "migrate", "seed", "setup",
    "start", "stop", "tui", "update",
];

/// `src/cli/index.ts:470-531`: the three answers that are not a command's, before `parse`.
pub fn pre_parse(argv: &[String]) -> Invocation {
    let Some(first) = argv.first() else {
        return Invocation::Help;
    };

    match first.as_str() {
        "-h" | "--help" => Invocation::Help,
        "-v" | "--version" => Invocation::Version,
        word if COMMANDS.contains(&word) => Invocation::Command,
        word => Invocation::Unknown(word.to_owned()),
    }
}

/// The process entry point, from the arguments after the binary's own name.
pub fn run(argv: Vec<String>) -> ExitCode {
    match pre_parse(&argv) {
        Invocation::Help => {
            print_lines(&page_lines());
            ExitCode::SUCCESS
        }
        Invocation::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Invocation::Unknown(word) => {
            // The marker is the error and the page is the help: the capture writes the first
            // with `logError` (stderr) and the second with `outputHelp` (stdout) (V46).
            eprintln!("Unknown command: {word}");
            print_lines(&page_lines());
            ExitCode::from(2)
        }
        Invocation::Command => {
            let cli = Cli::parse_from(std::iter::once(PROGRAM.to_owned()).chain(argv));
            let context = match Context::new() {
                Ok(context) => context,
                Err(error) => return render(Err(error)),
            };
            render(dispatch(cli.command, &context))
        }
    }
}

/// One command, dispatched. The only place that knows a subcommand exists.
fn dispatch(command: Command, context: &Context) -> Result<CommandOutput, CliError> {
    match command {
        Command::CleanDb { args } => commands::clean_db::run(context, &args),
        Command::Config { command } => match command {
            ConfigCommand::Validate { config_dir, config } => {
                commands::config::validate(&context.cwd, config_dir.as_deref(), config.as_deref())
            }
            ConfigCommand::Get {
                path,
                config_dir,
                json,
            } => commands::config::get(&context.cwd, config_dir.as_deref(), &path, json),
            ConfigCommand::List { config_dir, json } => {
                commands::config::list(&context.cwd, config_dir.as_deref(), json)
            }
            ConfigCommand::Set {
                path,
                value,
                config_dir,
                value_type,
                no_validate,
                restart,
            } => commands::config::set(
                context,
                config_dir.as_deref(),
                commands::config::SetRequest {
                    path: &path,
                    value: &value,
                    value_type: value_type.as_deref(),
                    validate: !no_validate,
                    restart,
                },
            ),
            ConfigCommand::Env { command } => match command {
                ConfigEnvCommand::List { show_secrets } => {
                    commands::config::env_list(&context.cwd, show_secrets)
                }
                ConfigEnvCommand::Get { key, show_secrets } => {
                    commands::config::env_get(&context.cwd, &key, show_secrets)
                }
                ConfigEnvCommand::Set { key, value } => {
                    commands::config::env_set(&context.cwd, &key, &value)
                }
                ConfigEnvCommand::Validate => commands::config::env_validate(&context.cwd),
            },
        },
        Command::Export {
            output,
            output_option,
            compress,
            format,
            data_dir,
        } => {
            let options = commands::export::ExportOptions {
                output: output_option.or(output),
                compress,
                format,
                data_dir,
            };
            let mut stdout = std::io::stdout().lock();
            commands::export::run(context, &options, &mut stdout)
        }
        Command::Import { args } => {
            let mut stdout = std::io::stdout().lock();
            commands::import::run(&args, &context.cwd, &mut stdout)
        }
        Command::Info {
            tor_hostname,
            i2p_hostname,
            json,
            data_dir,
        } => {
            let options = commands::info::InfoOptions {
                tor_hostname,
                i2p_hostname,
                json,
                data_dir,
            };
            commands::info::run(context, &options)
        }
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
        Command::Start {
            tor,
            i2p,
            nginx,
            debug,
            detach,
            port,
            args,
        } => {
            let options = commands::start::StartOptions {
                tor,
                i2p,
                nginx,
                debug,
                detach,
                port,
            };
            commands::start::run(context, &options, &args)
        }
        Command::Stop {
            tor,
            i2p,
            nginx,
            local,
            all,
            args,
        } => {
            let options = commands::stop::StopOptions {
                tor,
                i2p,
                nginx,
                local,
                all,
            };
            commands::stop::run(context, &options, &args)
        }
        Command::Update => commands::update::run().map(|_| CommandOutput::default()),
        Command::Tui => crate::tui::run().map(|_| CommandOutput::default()),
    }
}

/// The command line, as the parser reads it.
// `import` and `clean-db` parse their own arguments, so clap's `help` subcommand would render a
// second, contradictory page for them; `--help` is the single help surface.
#[derive(Debug, Parser)]
#[command(
    name = "nostream",
    about = "Operate a nostream relay",
    disable_help_subcommand = true,
    disable_version_flag = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Delete events by age or kind, or every event.
    #[command(disable_help_flag = true)]
    CleanDb {
        /// The command's own arguments, parsed by the command (see its help).
        #[arg(
            value_name = "ARGS",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
    /// Inspect and validate the effective settings.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Export events to a file.
    Export {
        /// Output path (alias to the positional argument)
        #[arg(value_name = "output")]
        output: Option<String>,
        /// Output path (alias to the positional argument)
        #[arg(long = "output", value_name = "output")]
        output_option: Option<String>,
        /// Enable compression (legacy compatibility)
        #[arg(short = 'z', long)]
        compress: bool,
        /// Export format (jsonl|json|gzip|gz|xz)
        #[arg(long, value_name = "format")]
        format: Option<String>,
        /// The store root (the LMDB environment lives under `<DIR>/lmdb`).
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
    },
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
    Info {
        /// Print the Tor hostname.
        #[arg(long)]
        tor_hostname: bool,
        /// Print the I2P hostnames.
        #[arg(long)]
        i2p_hostname: bool,
        /// Print the payload as JSON.
        #[arg(long)]
        json: bool,
        /// The store root (the LMDB environment lives under `<DIR>/lmdb`).
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
    },
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
    Start {
        /// Enable Tor hidden service
        #[arg(long)]
        tor: bool,
        /// Enable I2P hidden service
        #[arg(long)]
        i2p: bool,
        /// Enable nginx reverse proxy
        #[arg(long)]
        nginx: bool,
        /// Enable debug logging
        #[arg(long)]
        debug: bool,
        /// Run in detached mode
        #[arg(short = 'd', long)]
        detach: bool,
        /// Host port for the relay
        #[arg(long, value_name = "port")]
        port: Option<String>,
        /// Additional arguments passed to docker compose
        #[arg(
            value_name = "ARGS",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
    /// Stop the relay stack.
    Stop {
        /// Stop the Tor overlay
        #[arg(long)]
        tor: bool,
        /// Stop the I2P overlay
        #[arg(long)]
        i2p: bool,
        /// Stop the nginx overlay
        #[arg(long)]
        nginx: bool,
        /// Stop the local overlay
        #[arg(long)]
        local: bool,
        /// Stop every overlay
        #[arg(long)]
        all: bool,
        /// Additional arguments passed to docker compose
        #[arg(
            value_name = "ARGS",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
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
    /// Print the effective settings as YAML.
    List {
        /// The configuration directory (overrides NOSTR_CONFIG_DIR).
        #[arg(long)]
        config_dir: Option<PathBuf>,
        /// Print the document as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Print the effective value at a dot-path.
    #[command(override_usage = "nostream config get <path>")]
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
    /// Set a value at a dot-path and save the settings.
    Set {
        /// The dot-path to write (for example `info.relay_url`).
        path: String,
        /// The value, parsed as the type says.
        value: String,
        /// The configuration directory (overrides NOSTR_CONFIG_DIR).
        #[arg(long)]
        config_dir: Option<PathBuf>,
        /// How to parse the value: `inferred` or `json`.
        #[arg(long = "type", value_name = "type")]
        value_type: Option<String>,
        /// Write the value without validating the merged settings.
        #[arg(long)]
        no_validate: bool,
        /// Restart the relay stack after the write.
        #[arg(long)]
        restart: bool,
    },
    /// Read and write `.env`.
    #[command(
        override_usage = "nostream config env <list|get|set|validate> [args] [--show-secrets]"
    )]
    Env {
        #[command(subcommand)]
        command: ConfigEnvCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigEnvCommand {
    /// List the `.env` entries, secrets masked.
    List {
        /// Print secret values unmasked.
        #[arg(long)]
        show_secrets: bool,
    },
    /// Print one `.env` value.
    Get {
        /// The key to read.
        key: String,
        /// Print a secret value unmasked.
        #[arg(long)]
        show_secrets: bool,
    },
    /// Set one `.env` value.
    Set {
        /// The key to write.
        key: String,
        /// The value to write.
        value: String,
    },
    /// Validate the `.env` entries.
    Validate,
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

/// The `--json` failure envelope: `{"error":{"message":…,"code":N}}` (`src/cli/index.ts:129-131`).
///
/// It is a struct rather than a `serde_json::Value` because a map's key order is not the
/// contract's: the capture writes `message` first, and only a struct's declaration order is
/// guaranteed to keep it there.
#[derive(serde::Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

#[derive(serde::Serialize)]
struct ErrorBody<'a> {
    message: &'a str,
    code: u8,
}

/// Writes one command's `Result` — the single place that picks a stream and an exit code.
///
/// The three failure shapes are the capture's (R3, V63): a failure thrown out of a command is
/// prefixed `Error: ` and exits 2 (`Usage`) or 1 (`Command`); a failure the command reports
/// itself is written bare, line by line, with the code it chose (`Config`, `Reported`); and a
/// `--json` failure is the envelope. `Import` and `Migrate` keep the prefixes they shipped.
pub fn render(result: Result<CommandOutput, CliError>) -> ExitCode {
    match result {
        Ok(output) => {
            print_lines(&output.lines);
            output.exit_code()
        }
        Err(error) => {
            let code = match error {
                CliError::Usage(message) => {
                    eprintln!("Error: {message}");
                    2
                }
                CliError::Command(message) => {
                    eprintln!("Error: {message}");
                    1
                }
                CliError::Config(line) => {
                    eprintln!("{line}");
                    1
                }
                CliError::Reported { lines, exit_code } => {
                    for line in lines {
                        eprintln!("{line}");
                    }
                    exit_code
                }
                CliError::Json { message, code } => {
                    let envelope = ErrorEnvelope {
                        error: ErrorBody {
                            message: &message,
                            code,
                        },
                    };
                    match serde_json::to_string(&envelope) {
                        Ok(rendered) => eprintln!("{rendered}"),
                        Err(_) => {
                            eprintln!("{{\"error\":{{\"message\":\"error\",\"code\":{code}}}}}");
                        }
                    }
                    code
                }
                CliError::NotImplemented { module } => {
                    eprintln!("not implemented in Phase 1 (job 005): {module}");
                    1
                }
                CliError::Import(message) => {
                    eprintln!("Import failed: {message}");
                    1
                }
                CliError::Migrate(message) => {
                    eprintln!("Migration failed: {message}");
                    1
                }
            };
            ExitCode::from(code)
        }
    }
}

/// Prints lines on stdout, one per line.
fn print_lines(lines: &[String]) {
    for line in lines {
        println!("{line}");
    }
}
