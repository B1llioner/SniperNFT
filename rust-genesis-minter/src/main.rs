use alloy_primitives::{Address, keccak256};
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
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::ExitCode,
};
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
    /// Override the maximum NFT count (1..=100); minimum still comes from config.
    #[arg(long)]
    quantity: Option<u16>,
    /// Public setup/start/prepare with --send: derive the wallet from one hidden key prompt.
    #[arg(long, conflicts_with = "wallet")]
    wallet_from_key: bool,
    /// Select a wallet for read-only preflight/recover without entering its key.
    #[arg(long, conflicts_with = "wallet_from_key")]
    wallet: Option<Address>,
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

fn validate_wallet_selection(args: &Args, cfg: &Config) -> Result<()> {
    ensure!(
        !args.wallet_from_key || args.wallet.is_none(),
        "WALLET_SELECTION_FLAGS_CONFLICT"
    );
    if args.wallet_from_key {
        ensure!(
            args.send && matches!(args.action, Action::Setup | Action::Start | Action::Prepare),
            "WALLET_FROM_KEY_REQUIRES_SEND_SETUP_START_OR_PREPARE"
        );
        ensure!(
            cfg.mode == Mode::Public,
            "WALLET_FROM_KEY_REQUIRES_PUBLIC_MODE"
        );
    }
    if args.wallet.is_some() {
        ensure!(
            !args.send && matches!(args.action, Action::Preflight | Action::Recover),
            "WALLET_OVERRIDE_REQUIRES_READ_ONLY_PREFLIGHT_OR_RECOVER"
        );
    }
    Ok(())
}

fn apply_quantity_override(args: &Args, cfg: &mut Config) -> Result<()> {
    if let Some(quantity) = args.quantity {
        ensure!(
            (1..=100).contains(&quantity) && (1..=quantity).contains(&cfg.min_quantity),
            "INVALID_QUANTITY"
        );
        cfg.quantity = quantity;
        // Config::load already validated the original configuration. With an
        // explicit wallet selection, validate recipient binding once that wallet
        // is known; reject numeric limits before any hidden key prompt.
        if !args.wallet_from_key && args.wallet.is_none() {
            cfg.validate(args.local_test)?;
        }
    }
    Ok(())
}

fn select_wallet(args: &Args, cfg: &mut Config, signer: Option<&Signer>) -> Result<()> {
    validate_wallet_selection(args, cfg)?;
    if args.wallet_from_key {
        cfg.wallet = signer
            .ok_or_else(|| anyhow::anyhow!("DERIVED_WALLET_SIGNER_REQUIRED"))?
            .address();
    } else if let Some(wallet) = args.wallet {
        cfg.wallet = wallet;
    }
    cfg.validate(args.local_test)
}

fn wallet_state_root(root: &Path, wallet: Address) -> PathBuf {
    root.join(format!("{CHAIN_ID}-{wallet}"))
}

fn parse_signer(key: &str, cfg: &Config, derive_wallet: bool) -> Result<Signer> {
    let signer = Signer::from_key(key.trim())?;
    ensure!(
        derive_wallet || signer.address() == cfg.wallet,
        "KEY_DOES_NOT_MATCH_CONFIGURED_WALLET"
    );
    Ok(signer)
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
        Some(parse_signer(&key, cfg, args.wallet_from_key)?)
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
    let mut cfg = Config::load(&args.config, args.local_test)?;
    apply_quantity_override(&args, &mut cfg)?;
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
    validate_wallet_selection(&args, &cfg)?;
    let artifact = Artifact::load("GenesisChildFactory")?;
    // Only explicit public auto-wallet mode needs the hidden key before state
    // lookup. Keep this signer for the entire run; never prompt a second time.
    // Legacy mode retains chain preflight before its credential prompts.
    let derived_signer = if args.wallet_from_key {
        let (signer, _) = secrets(&args, &cfg, true, false)?;
        signer
    } else {
        None
    };
    select_wallet(&args, &mut cfg, derived_signer.as_ref())?;
    let identity = Identity {
        chain_id: CHAIN_ID,
        owner: cfg.wallet,
        nft: cfg.nft,
        recipient: cfg.recipient(),
        artifact_hash: keccak256(&artifact.init),
    };
    let root = wallet_state_root(&args.state_dir, cfg.wallet);
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
    // Legacy prompts follow read-only checks. Auto-wallet mode already derived
    // its identity from the key, and validates that wallet's saved factory here.
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
    let (signer, prompted_api) = if let Some(signer) = derived_signer {
        (Some(signer), None)
    } else {
        secrets(&args, &cfg, args.send, minting && cfg.mode != Mode::Public)?
    };
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

#[cfg(test)]
mod wallet_selection_tests {
    use super::*;
    use alloy_primitives::B256;
    use rust_genesis_minter::state::{Action as StateAction, Pending};
    use rust_mint_benchmark::signing::predict_create;
    use serde_json::json;

    // Public, deterministic local fixtures. Never use these keys for funds.
    const KEY_A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const KEY_B: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    fn config() -> Config {
        serde_json::from_value(json!({
            "wallet": Address::repeat_byte(0x11), "mode": "public"
        }))
        .unwrap()
    }

    fn args(action: &str, flags: &[&str]) -> Args {
        let mut values = vec!["vinos-genesis", action, "--config", "synthetic.json"];
        values.extend_from_slice(flags);
        Args::try_parse_from(values).unwrap()
    }

    fn identity(cfg: &Config) -> Identity {
        Identity {
            chain_id: CHAIN_ID,
            owner: cfg.wallet,
            nft: cfg.nft,
            recipient: cfg.recipient(),
            artifact_hash: B256::repeat_byte(9),
        }
    }

    #[test]
    fn wallet_from_key_requires_explicit_send_and_public_mutating_action() {
        let cfg = config();
        for action in ["setup", "start", "prepare"] {
            assert!(
                validate_wallet_selection(&args(action, &["--wallet-from-key", "--send"]), &cfg)
                    .is_ok()
            );
            assert!(
                validate_wallet_selection(&args(action, &["--wallet-from-key"]), &cfg).is_err()
            );
        }
        for action in ["preflight", "recover", "check-children"] {
            assert!(
                validate_wallet_selection(&args(action, &["--wallet-from-key", "--send"]), &cfg)
                    .is_err()
            );
        }
        for mode in [Mode::Signed, Mode::Auto] {
            let mut cfg = config();
            cfg.mode = mode;
            assert!(
                validate_wallet_selection(&args("setup", &["--wallet-from-key", "--send"]), &cfg)
                    .is_err()
            );
        }
    }

    #[test]
    fn explicit_wallet_is_only_for_read_only_preflight_or_recover() {
        let address = Address::repeat_byte(0x22).to_string();
        for action in ["preflight", "recover"] {
            assert!(
                validate_wallet_selection(&args(action, &["--wallet", &address]), &config())
                    .is_ok()
            );
            assert!(
                validate_wallet_selection(
                    &args(action, &["--wallet", &address, "--send"]),
                    &config()
                )
                .is_err()
            );
        }
        for action in ["setup", "start", "prepare", "check-children"] {
            assert!(
                validate_wallet_selection(&args(action, &["--wallet", &address]), &config())
                    .is_err()
            );
        }
    }

    #[test]
    fn parser_rejects_ambiguous_wallet_selection_and_invalid_address() {
        assert!(
            Args::try_parse_from([
                "vinos-genesis",
                "setup",
                "--config",
                "synthetic.json",
                "--send",
                "--wallet-from-key",
                "--wallet",
                "0x1111111111111111111111111111111111111111"
            ])
            .is_err()
        );
        assert!(
            Args::try_parse_from([
                "vinos-genesis",
                "preflight",
                "--config",
                "synthetic.json",
                "--wallet",
                "not-an-address"
            ])
            .is_err()
        );
    }

    #[test]
    fn derived_identity_and_default_recipient_follow_the_hidden_key() {
        let mut cfg = config();
        let signer = parse_signer(KEY_A, &cfg, true).unwrap();
        let selected = args("setup", &["--wallet-from-key", "--send"]);
        select_wallet(&selected, &mut cfg, Some(&signer)).unwrap();
        assert_eq!(cfg.wallet, signer.address());
        assert_eq!(cfg.recipient(), signer.address());
        assert_ne!(cfg.wallet, config().wallet);
        assert_eq!(identity(&cfg).owner, signer.address());
        assert!(
            wallet_state_root(Path::new("state"), cfg.wallet)
                .ends_with(format!("4663-{}", signer.address()))
        );
        assert!(select_wallet(&selected, &mut cfg, None).is_err());
    }

    #[test]
    fn legacy_wallet_binding_and_explicit_recipient_are_preserved() {
        let mut cfg = config();
        assert!(parse_signer(KEY_A, &cfg, false).is_err());
        let signer = parse_signer(KEY_A, &cfg, true).unwrap();
        cfg.wallet = signer.address();
        assert!(parse_signer(KEY_A, &cfg, false).is_ok());
        assert!(parse_signer(KEY_B, &cfg, false).is_err());
        assert_eq!(
            parse_signer("synthetic-invalid-key", &cfg, true)
                .err()
                .unwrap()
                .to_string(),
            "INVALID_PRIVATE_KEY"
        );
        let recipient = Address::repeat_byte(0x33);
        cfg.recipient = Some(recipient);
        select_wallet(
            &args("setup", &["--wallet-from-key", "--send"]),
            &mut cfg,
            Some(&signer),
        )
        .unwrap();
        assert_eq!(cfg.recipient(), recipient);
        let old_wallet = cfg.wallet;
        select_wallet(&args("preflight", &[]), &mut cfg, None).unwrap();
        assert_eq!(cfg.wallet, old_wallet);
    }

    #[test]
    fn read_only_selection_needs_no_signer_and_revalidates_the_wallet() {
        let mut cfg = config();
        let address = Address::repeat_byte(0x22);
        select_wallet(
            &args("recover", &["--wallet", &address.to_string()]),
            &mut cfg,
            None,
        )
        .unwrap();
        assert_eq!(cfg.wallet, address);
        assert!(
            select_wallet(
                &args("preflight", &["--wallet", &Address::ZERO.to_string()]),
                &mut cfg,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn direct_quantity_override_binds_recipient_to_the_selected_wallet() {
        let signer = parse_signer(KEY_A, &config(), true).unwrap();
        let mut original = config();
        original.recipient = Some(signer.address());
        original.validate(false).unwrap();
        assert_ne!(original.wallet, signer.address());

        let selected = args("setup", &["--wallet-from-key", "--send", "--quantity", "1"]);
        let mut derived = original.clone();
        apply_quantity_override(&selected, &mut derived).unwrap();
        select_wallet(&selected, &mut derived, Some(&signer)).unwrap();
        assert_eq!(derived.quantity, 1);
        assert_eq!(derived.recipient(), derived.wallet);

        let selected = args(
            "preflight",
            &["--wallet", &signer.address().to_string(), "--quantity", "1"],
        );
        let mut read_only = original.clone();
        apply_quantity_override(&selected, &mut read_only).unwrap();
        select_wallet(&selected, &mut read_only, None).unwrap();
        assert_eq!(read_only.recipient(), read_only.wallet);

        let selected = args("setup", &["--wallet-from-key", "--send", "--quantity", "1"]);
        let mut wrong_recipient = original.clone();
        wrong_recipient.recipient = Some(Address::repeat_byte(0x33));
        apply_quantity_override(&selected, &mut wrong_recipient).unwrap();
        assert_eq!(
            select_wallet(&selected, &mut wrong_recipient, Some(&signer))
                .unwrap_err()
                .to_string(),
            "DIRECT_MINT_REQUIRES_WALLET_RECIPIENT"
        );

        // Legacy mode still rejects a mismatched recipient before key entry.
        assert_eq!(
            apply_quantity_override(
                &args("setup", &["--send", "--quantity", "1"]),
                &mut original
            )
            .unwrap_err()
            .to_string(),
            "DIRECT_MINT_REQUIRES_WALLET_RECIPIENT"
        );
    }

    #[test]
    fn selected_wallet_quantity_limits_are_checked_before_key_entry() {
        for (quantity, minimum) in [("0", 1), ("101", 1), ("1", 2)] {
            let selected = args(
                "setup",
                &["--wallet-from-key", "--send", "--quantity", quantity],
            );
            let mut cfg = config();
            cfg.min_quantity = minimum;
            assert_eq!(
                apply_quantity_override(&selected, &mut cfg)
                    .unwrap_err()
                    .to_string(),
                "INVALID_QUANTITY"
            );
        }
    }

    #[tokio::test]
    async fn derived_wallets_have_independent_locks_and_reuse_the_existing_registry() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let selected = args("setup", &["--wallet-from-key", "--send"]);
        let mut cfg_a = config();
        let mut cfg_b = config();
        let signer_a = parse_signer(KEY_A, &cfg_a, true).unwrap();
        let signer_b = parse_signer(KEY_B, &cfg_b, true).unwrap();
        select_wallet(&selected, &mut cfg_a, Some(&signer_a)).unwrap();
        select_wallet(&selected, &mut cfg_b, Some(&signer_b)).unwrap();
        let root_a = wallet_state_root(&base, cfg_a.wallet);
        let root_b = wallet_state_root(&base, cfg_b.wallet);
        assert_ne!(root_a, root_b);
        let mut a = Store::open(&root_a, identity(&cfg_a)).unwrap();
        let b = Store::open(&root_b, identity(&cfg_b)).unwrap();
        assert_eq!(b.state.gas_cost_wei, 0);
        assert!(b.state.factory.is_none());
        assert!(Store::open(&root_a, identity(&cfg_a)).is_err());
        let factory = predict_create(cfg_a.wallet, 7);
        let hash = B256::repeat_byte(1);
        a.intent(Pending {
            hash,
            nonce: 7,
            to: None,
            action: StateAction::DeployFactory { predicted: factory },
            gas_limit: 21_000,
            max_fee_per_gas: 2,
            max_cost_wei: 42_000,
        })
        .await
        .unwrap();
        a.resolve(hash, 40_000, Some(factory), Some(10))
            .await
            .unwrap();
        let pending_hash = B256::repeat_byte(2);
        a.intent(Pending {
            hash: pending_hash,
            nonce: 8,
            to: Some(factory),
            action: StateAction::PrepareChildren { count: 2 },
            gas_limit: 21_000,
            max_fee_per_gas: 2,
            max_cost_wei: 42_000,
        })
        .await
        .unwrap();
        drop(a);
        let reopened = Store::open(&root_a, identity(&cfg_a)).unwrap();
        assert_eq!(reopened.state.factory, Some(factory));
        assert_eq!(reopened.state.gas_cost_wei, 40_000);
        assert_eq!(reopened.state.last_receipt_block, Some(10));
        assert_eq!(reopened.state.pending.as_ref().unwrap().hash, pending_hash);
        drop(reopened);
        assert_eq!(
            Store::open(&root_a, identity(&cfg_b))
                .err()
                .unwrap()
                .to_string(),
            "STATE_IDENTITY_MISMATCH_DO_NOT_REDEPLOY"
        );
        let raw_state = std::fs::read_to_string(root_a.join("state.json")).unwrap();
        assert!(!raw_state.contains(KEY_A));
        assert!(!raw_state.contains(KEY_B));
    }
}
