use alloy_primitives::keccak256;
use anyhow::{Result, ensure};
use clap::{Parser, ValueEnum};
use rust_genesis_minter::{
    artifact::Artifact,
    config::{CHAIN_ID, Config, Mode},
    opensea::OpenSeaClient,
    run::{Command, Options, Session},
    state::{Identity, Store},
};
use rust_mint_benchmark::signing::Signer;
use std::{io::Read, path::PathBuf, process::ExitCode};
use zeroize::Zeroizing;

#[derive(Clone, Copy, ValueEnum)]
enum Action {
    Preflight,
    Prepare,
    Setup,
    Start,
    Recover,
    /// Prepare two children, obtain an automatic OpenSea API key, simulate only.
    CheckChildren,
}
#[derive(Parser)]
#[command(
    name = "vinos-genesis",
    about = "Free Genesis mint: prepare children, refresh authorized OpenSea payloads, simulate and submit one batch"
)]
struct Args {
    #[arg(value_enum, default_value = "preflight")]
    action: Action,
    /// Sanitized JSON config; never put keys or signatures in it.
    #[arg(long)]
    config: PathBuf,
    /// Persistent registry root; reuse the SAME root on subsequent runs.
    #[arg(long, default_value = ".state/genesis-signed")]
    state_dir: PathBuf,
    /// Authorize requested writes. Check-children only writes preparation, never mint.
    #[arg(long)]
    send: bool,
    /// Isolated tests only: all RPCs must use literal loopback addresses.
    #[arg(long, hide = true)]
    local_test: bool,
    /// Local test fixture API origin; impossible to use in production mode.
    #[arg(long, hide = true)]
    test_api_origin: Option<String>,
    /// Local test only: synthetic private key line, then synthetic API key line.
    #[arg(long, hide = true)]
    test_secrets_stdin: bool,
}

async fn interrupted() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {result=tokio::signal::ctrl_c()=>{result?;}, _=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
fn secrets(
    args: &Args,
    cfg: &Config,
    need_signer: bool,
    need_api: bool,
) -> Result<(Option<Signer>, Option<OpenSeaClient>)> {
    let (key, api_key) = if args.test_secrets_stdin {
        ensure!(args.local_test, "STDIN_SECRETS_REQUIRE_ISOLATED_LOCAL_TEST");
        let mut input = Zeroizing::new(String::new());
        std::io::stdin().take(2049).read_to_string(&mut input)?;
        ensure!(input.len() <= 2048, "SYNTHETIC_INPUT_TOO_LARGE");
        let mut lines = input.lines();
        let a = Zeroizing::new(lines.next().unwrap_or("").to_owned());
        let b = Zeroizing::new(lines.next().unwrap_or("").to_owned());
        ensure!(lines.next().is_none(), "INVALID_SYNTHETIC_INPUT_LINES");
        (a, b)
    } else {
        let a = if need_signer {
            Zeroizing::new(rpassword::prompt_password(
                "Private key (hidden, never saved): ",
            )?)
        } else {
            Zeroizing::new(String::new())
        };
        let b = if need_api {
            Zeroizing::new(rpassword::prompt_password(
                "OpenSea API key (hidden, never saved): ",
            )?)
        } else {
            Zeroizing::new(String::new())
        };
        (a, b)
    };
    let signer = if need_signer {
        let signer = Signer::from_key(key.trim())?;
        ensure!(
            signer.address() == cfg.wallet,
            "KEY_DOES_NOT_MATCH_CONFIGURED_WALLET"
        );
        Some(signer)
    } else {
        None
    };
    let api = if need_api {
        Some(if let Some(origin) = &args.test_api_origin {
            ensure!(args.local_test, "CUSTOM_API_REQUIRES_LOCAL_TEST");
            OpenSeaClient::new_local_test(api_key, origin)?
        } else {
            OpenSeaClient::new(api_key)?
        })
    } else {
        None
    };
    Ok((signer, api))
}
fn entry() -> Result<u8> {
    let args = Args::parse();
    ensure!(
        args.local_test || (!args.test_secrets_stdin && args.test_api_origin.is_none()),
        "LOCAL_TEST_OPTIONS_FORBIDDEN_IN_PRODUCTION"
    );
    let cfg = Config::load(&args.config, args.local_test)?;
    if matches!(args.action, Action::CheckChildren) {
        ensure!(
            cfg.quantity == 2 && cfg.min_quantity == 2 && cfg.mode == Mode::Signed,
            "CHILD_CHECK_REQUIRES_QUANTITY_2_MINIMUM_2_SIGNED_MODE"
        );
    }
    ensure!(
        !args.send || !matches!(args.action, Action::Preflight | Action::Recover),
        "PREFLIGHT_AND_RECOVER_ARE_READ_ONLY"
    );
    let artifact = Artifact::load("GenesisChildFactory")?;
    let identity = Identity {
        chain_id: CHAIN_ID,
        owner: cfg.wallet,
        nft: cfg.nft,
        recipient: cfg.recipient(),
        artifact_hash: keccak256(&artifact.init),
    };
    let root = args.state_dir.join(format!("{CHAIN_ID}-{}", cfg.wallet));
    let mut store = Store::open(&root, identity)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut session = runtime.block_on(Session::open(cfg.clone(), args.local_test))?;
    // Recover before prompts and current drop checks: a completed mint remains
    // recoverable even if its stage or approved SeaDrop has since changed.
    let recovered_mint = store
        .state
        .pending
        .as_ref()
        .is_some_and(|p| matches!(p.action, rust_genesis_minter::state::Action::Mint { .. }));
    if matches!(args.action, Action::Recover)
        || (recovered_mint && !matches!(args.action, Action::Preflight))
    {
        let recovered = runtime.block_on(session.execute(
            &mut store,
            None,
            None,
            &Options {
                command: Command::Recover,
                send: false,
                local: args.local_test,
            },
        ))?;
        ensure!(
            !matches!(args.action, Action::CheckChildren),
            "PENDING_MINT_RECOVERED_CHILD_CHECK_NOT_PERFORMED_RERUN_CHECK"
        );
        return Ok(recovered);
    }
    if store.state.pending.is_some() && !matches!(args.action, Action::Preflight) {
        runtime.block_on(session.recover(&mut store, false))?;
    }
    // Read-only chain identity checks precede both hidden credential prompts.
    runtime.block_on(session.preflight(&store))?;
    // Obtain a short-lived anonymous API key BEFORE asking for wallet material
    // or submitting preparation. Credential bodies are never persisted/logged.
    let automatic_api = if matches!(args.action, Action::CheckChildren) {
        let (client, metadata) = runtime.block_on(async {
            if let Some(origin) = &args.test_api_origin {
                OpenSeaClient::ephemeral_local_test(origin).await
            } else {
                OpenSeaClient::ephemeral().await
            }
        })?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        ensure!(
            metadata.expires_at_unix_seconds
                > now
                    .saturating_add(cfg.wait_timeout_secs)
                    .saturating_add(600),
            "EPHEMERAL_API_KEY_LIFETIME_TOO_SHORT"
        );
        ensure!(
            metadata.rate_limits.fulfillment.requests >= 2
                && metadata.rate_limits.write.requests >= 2
                && metadata.rate_limits.read.requests >= 2,
            "EPHEMERAL_API_QUOTA_TOO_SMALL_FOR_TWO_CHILDREN"
        );
        let event = serde_json::json!({"event":"automatic_api_key_ready",
            "expiresAtUnixSeconds":metadata.expires_at_unix_seconds,
            "plannedMintApiRequests":2,"rateLimits":metadata.rate_limits,"keySaved":false});
        runtime.block_on(store.event(&event))?;
        println!("{event}");
        Some(client)
    } else {
        None
    };
    let minting = matches!(args.action, Action::Setup | Action::Start);
    let (signer, prompted_api) =
        secrets(&args, &cfg, args.send, minting && cfg.mode != Mode::Public)?;
    let api = automatic_api.or(prompted_api);
    let command = match args.action {
        Action::Preflight => Command::Preflight,
        Action::Prepare => Command::Prepare,
        Action::Setup => Command::Setup,
        Action::Start => Command::Start,
        Action::Recover => Command::Recover,
        Action::CheckChildren => Command::CheckChildren,
    };
    let options = Options {
        command,
        send: args.send,
        local: args.local_test,
    };
    runtime.block_on(async{
        tokio::select!{
            result=session.execute(&mut store,signer.as_ref(),api.as_ref(),&options)=>result,
            signal=interrupted()=>{signal?;Err(anyhow::anyhow!("INTERRUPTED_CHECK_PENDING_HASH_BEFORE_RESTART"))}
        }
    })
}
fn main() -> ExitCode {
    match entry() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("Stopped: {error}");
            ExitCode::FAILURE
        }
    }
}
