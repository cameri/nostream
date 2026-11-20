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

use std::io::Write;
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

    /// Enters the runtime, so a command can spawn a task that runs alongside its futures.
    pub fn enter(&self) -> tokio::runtime::EnterGuard<'_> {
        self.runtime.enter()
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
    /// `start` with a `--port` that received no value: the port's own message, at exit 1.
    Port,
    /// A word that is no command: `Unknown command: <word>`, at exit 2.
    Unknown(String),
}

/// The top-level words, in the page's order. A word not here is the capture's unknown command
/// (`src/cli/index.ts:514-518`), which is answered before the parser runs.
pub const COMMANDS: &[&str] = &[
    "clean", "clean-db", "config", "export", "import", "info", "invite", "migrate", "seed",
    "setup", "start", "stop", "tui", "update",
];

/// `src/cli/index.ts:470-531`: the four answers that are not a command's, before `parse` — the
/// page, the version, the unknown word, and `start`'s valueless `--port` (D1).
pub fn pre_parse(argv: &[String]) -> Invocation {
    let Some(first) = argv.first() else {
        return Invocation::Help;
    };

    match first.as_str() {
        "-h" | "--help" => Invocation::Help,
        "-v" | "--version" => Invocation::Version,
        word if COMMANDS.contains(&word) => {
            // V5's second boundary: the capture reads its own `argv` for the flag
            // (`src/cli/commands/start.ts:74-78`) and throws the port's message, so a flag whose
            // value never arrived is answered here rather than as the parser's missing-value
            // error at exit 2.
            if word == "start" && port_without_a_value(argv) {
                Invocation::Port
            } else {
                Invocation::Command
            }
        }
        word => Invocation::Unknown(word.to_owned()),
    }
}

/// Whether a `start` invocation names `--port` with no value after it. A following word that
/// starts with `-` is another flag rather than a value, which is also how the parser reads it.
fn port_without_a_value(argv: &[String]) -> bool {
    argv.iter().enumerate().any(|(index, word)| {
        word == "--port"
            && match argv.get(index + 1) {
                Some(next) => next.starts_with('-'),
                None => true,
            }
    })
}

/// The process entry point, from the arguments after the binary's own name.
pub fn run(argv: Vec<String>) -> ExitCode {
    match pre_parse(&argv) {
        Invocation::Help => print_page(&page_lines(), 0),
        // The version line is data like the page, so a write that fails answers the same way:
        // one line on stderr and exit 1, never `println!`'s panic at 101 (V1).
        Invocation::Version => print_page(&[version_line()], 0),
        Invocation::Port => render(Err(CliError::command(commands::start::PORT_MESSAGE))),
        Invocation::Unknown(word) => {
            // The marker is the error and the page is the help: the capture writes the first
            // with `logError` (stderr) and the second with `outputHelp` (stdout) (V46).
            let _ = print_error_lines(&[format!("Unknown command: {word}")]);
            print_page(&page_lines(), 2)
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

/// Prints `lines` on stdout and answers `code`, with `render`'s rule for a write that failed: a
/// closed reader ends the output at that code rather than at exit 101, and any other error is one
/// line on stderr.
///
/// The code a caller passes is the answer it already has. A page that could not be written is a
/// failure when the page *was* the answer (`--help`, `--version`: 0 becomes 1), and stays the
/// answer when the page was a failure's decoration (`Unknown command:` keeps 2) — a write the
/// stream refused does not re-code what the command decided.
fn print_page(lines: &[String], code: u8) -> ExitCode {
    match print_lines(lines) {
        Ok(()) => ExitCode::from(code),
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => ExitCode::from(code),
        Err(error) => {
            let _ = print_error_lines(&[format!("Error: unable to write output: {error}")]);
            ExitCode::from(if code == 0 { 1 } else { code })
        }
    }
}

/// One command, dispatched. The only place that knows a subcommand exists.
fn dispatch(command: Command, context: &Context) -> Result<CommandOutput, CliError> {
    match command {
        Command::Clean => commands::clean::run(context),
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
            commands::import::run(&args, &context.cwd, &context.env, &mut stdout)
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
        Command::Invite { command } => match command {
            Some(InviteCommand::Create {
                uses,
                expires_in,
                json,
                data_dir,
            }) => commands::invite::run(
                context,
                &commands::invite::InviteOptions {
                    uses,
                    expires_in,
                    json,
                    data_dir,
                },
            ),
            None => Err(CliError::usage(commands::invite::INVITE_USAGE)),
        },
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
        Command::Seed { count, data_dir } => {
            commands::seed::run(context, &commands::seed::SeedOptions { count, data_dir })
        }
        Command::Setup { yes, start } => {
            commands::setup::run(context, &commands::setup::SetupOptions { yes, start })
        }
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
        Command::Update { args } => commands::update::run(context, &args),
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
    /// Clean Docker resources (legacy script replacement).
    Clean,
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
    Invite {
        #[command(subcommand)]
        command: Option<InviteCommand>,
    },
    /// Copy the Postgres store into an LMDB store.
    Migrate {
        #[command(subcommand)]
        command: MigrateCommand,
    },
    /// Seed the database.
    Seed {
        /// Number of events to seed
        #[arg(long, value_name = "count")]
        count: Option<String>,
        /// The store root (the LMDB environment lives under `<DIR>/lmdb`).
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
    },
    /// Run the first-time setup flow.
    Setup {
        /// Non-interactive defaults
        #[arg(short = 'y', long)]
        yes: bool,
        /// Start relay after setup
        #[arg(long)]
        start: bool,
    },
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
    Update {
        /// Additional arguments passed to docker compose when the stack restarts
        #[arg(
            value_name = "ARGS",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        args: Vec<String>,
    },
    /// Run the interactive settings editor.
    Tui,
}

#[derive(Debug, Subcommand)]
enum InviteCommand {
    /// Mint an invite code.
    Create {
        /// Times the code can be claimed (default: nip43.defaultMaxUses)
        #[arg(long, value_name = "uses")]
        uses: Option<String>,
        /// Code lifetime in seconds (default: nip43.inviteCodeExpirySeconds)
        #[arg(long = "expires-in", value_name = "seconds")]
        expires_in: Option<String>,
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
        /// The store root (the LMDB environment lives under `<DIR>/lmdb`).
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
    },
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
        Ok(output) => match print_lines(&output.lines) {
            Ok(()) => output.exit_code(),
            // A closed reader — `nostream config list | head -1` — ends the output and leaves the
            // command's own code alone: `println!` panics on a broken pipe, and exit 101 is
            // outside the surface's 0/1/2 vocabulary (V1).
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => output.exit_code(),
            Err(error) => {
                let _ = print_error_lines(&[format!("Error: unable to write output: {error}")]);
                ExitCode::from(1)
            }
        },
        Err(error) => {
            let (code, lines) = match failure_lines(error) {
                Failure::ReportedFirst {
                    output,
                    lines,
                    code,
                } => {
                    // The data was earned before the failure happened, so it keeps the stream a
                    // successful run writes it to; only the failure goes to stderr.
                    let _ = print_lines(&output);
                    (code, lines)
                }
                Failure::Lines { lines, code } => (code, lines),
            };
            // A write failure on the stream a failure goes to is not a panic and does not
            // re-code the answer: there is nowhere left to report it, so the command's code
            // stands. `eprintln!` here panicked at 101 on a full disk, which is the defect.
            let _ = print_error_lines(&lines);
            ExitCode::from(code)
        }
    }
}

/// One failure, as the lines it renders to and the code it answers.
enum Failure {
    /// The capture's three shapes and the two the binary shipped (`Import`, `Migrate`) — every
    /// line goes to stderr.
    Lines { lines: Vec<String>, code: u8 },
    /// [`CliError::ReportedAfter`]: data the command earned on stdout first, then the failure.
    ReportedFirst {
        output: Vec<String>,
        lines: Vec<String>,
        code: u8,
    },
}

/// Renders one failure: the single place a class becomes a stream's bytes and a code.
fn failure_lines(error: CliError) -> Failure {
    let (lines, code) = match error {
        CliError::Usage(message) => (vec![format!("Error: {message}")], 2),
        CliError::Command(message) => (vec![format!("Error: {message}")], 1),
        CliError::Config(line) => (vec![line], 1),
        CliError::Reported { lines, exit_code } => (lines, exit_code),
        CliError::ReportedAfter { output, failure } => {
            return match failure_lines(*failure) {
                Failure::Lines { lines, code } => Failure::ReportedFirst {
                    output,
                    lines,
                    code,
                },
                // A wrapper inside a wrapper: the earned lines keep the order the commands
                // wrote them in, outer first.
                Failure::ReportedFirst {
                    output: inner_output,
                    lines,
                    code,
                } => {
                    let mut all = output;
                    all.extend(inner_output);
                    Failure::ReportedFirst {
                        output: all,
                        lines,
                        code,
                    }
                }
            };
        }
        CliError::Json { message, code } => {
            let envelope = ErrorEnvelope {
                error: ErrorBody {
                    message: &message,
                    code,
                },
            };
            let rendered = serde_json::to_string(&envelope).unwrap_or_else(|_| {
                format!("{{\"error\":{{\"message\":\"error\",\"code\":{code}}}}}")
            });
            (vec![rendered], code)
        }
        CliError::NotImplemented { module } => (
            vec![format!("not implemented in Phase 1 (job 005): {module}")],
            1,
        ),
        CliError::Import(message) => (vec![format!("Import failed: {message}")], 1),
        CliError::Migrate(message) => (vec![format!("Migration failed: {message}")], 1),
    };

    Failure::Lines { lines, code }
}

/// Prints lines on stdout, one per line.
fn print_lines(lines: &[String]) -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();

    for line in lines {
        writeln!(stdout, "{line}")?;
    }

    Ok(())
}

/// Prints lines on stderr, one per line, answering the write's result for the same reason
/// [`print_lines`] does: a full disk is the write's failure, not a panic.
fn print_error_lines(lines: &[String]) -> std::io::Result<()> {
    let mut stderr = std::io::stderr().lock();

    for line in lines {
        writeln!(stderr, "{line}")?;
    }

    Ok(())
}
