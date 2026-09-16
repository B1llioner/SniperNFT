use std::{io::Read, process::ExitCode};

use anyhow::{Result, ensure};
use clap::Parser;
use rust_mint_benchmark::{config::Args, journal::Journal, plan, run, signing::Signer};
use serde_json::json;
use zeroize::Zeroizing;

fn read_key(args: &Args) -> Result<Signer> {
    let key = if args.test_key_stdin {
        ensure!(
            args.local(),
            "Synthetic stdin keys require loopback endpoints"
        );
        let mut text = Zeroizing::new(String::new());
        std::io::stdin().take(128).read_to_string(&mut text)?;
        ensure!(text.len() < 128, "Invalid private key input length");
        text
    } else {
        Zeroizing::new(rpassword::prompt_password(
            "Private key (hidden, not saved): ",
        )?)
    };
    let signer = Signer::from_key(key.trim())?;
    ensure!(
        signer.address() == args.wallet,
        "Entered key does not match --wallet; no transaction sent"
    );
    Ok(signer)
}

async fn interrupted() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => { result?; },
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

fn main() -> ExitCode {
    match entry() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            // Transport and signing errors are redacted at their boundaries.
            // Never print Debug for args, signers, keys, or raw transactions.
            eprintln!(
                "Benchmark stopped: {error}. Inspect the journal hashes before another live run."
            );
            ExitCode::FAILURE
        }
    }
}

fn entry() -> Result<u8> {
    let args = Args::parse();
    args.validate()?;
    ensure!(
        !args.output.exists(),
        "Output directory exists; choose a fresh path"
    );
    if args.send {
        Journal::ensure_wallet_available(&args.lock_dir, args.wallet)?;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let initial = runtime.block_on(plan::preflight(&args))?;
    println!("{}", initial.report(&args));
    if !args.send {
        runtime.block_on(async {
            let journal = Journal::create(&args.output, &args.lock_dir, args.wallet, false).await?;
            journal.save("plan.json", &initial.report(&args)).await
        })?;
        println!("Read-only preflight passed. No private key read; no transaction sent.");
        return Ok(0);
    }
    // Read the secret before installing async signal handlers; it is never a
    // command-line argument, environment variable, config value, or log field.
    let signer = read_key(&args)?;
    runtime.block_on(async {
        let mut journal = Journal::create(&args.output,&args.lock_dir,args.wallet,true).await?;
        journal.save("initial-plan.json",&initial.report(&args)).await?;
        let outcome = tokio::select! {
            result = async {
                let fresh = plan::preflight(&args).await?;
                journal.save("plan.json",&fresh.report(&args)).await?;
                journal.append(json!({"type":"live_plan","plan":fresh.report(&args)})).await?;
                run::execute(&args,fresh,&signer,&mut journal).await
            } => result,
            signal = interrupted() => {
                signal?;
                Err(anyhow::anyhow!("Interrupted; one or more journal hashes may already have been submitted"))
            },
        };
        match outcome {
            Ok(report) => {
                journal.save("result.json",&report).await?;
                journal.append(json!({"type":"finished","allTenFullBatchesInFirstBlock":report["allTenFullBatchesInFirstBlock"]})).await?;
                journal.mark_resolved().await?;
                println!("Result saved to the selected output directory. Total gas cost: {} wei",report["gasCostWei"]);
                Ok(if report["allTenFullBatchesInFirstBlock"] == true {0}else{2})
            },
            Err(error) => {
                journal.append(json!({"type":"stopped","error":error.to_string(),"action":"reconcile all prepared hashes; no automatic retry"})).await?;
                Err(error)
            },
        }
    })
}
