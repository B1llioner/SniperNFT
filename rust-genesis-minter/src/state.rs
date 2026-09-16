//! One durable factory registry and pending intent per selected wallet directory.
//! Never persists a private key, server signature, calldata or signed raw tx.
use alloy_primitives::{Address, B256};
use anyhow::{Result, ensure};
use fs2::FileExt;
use rust_mint_benchmark::signing::predict_create;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub chain_id: u64,
    pub owner: Address,
    pub nft: Address,
    pub recipient: Address,
    pub artifact_hash: B256,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    DeployFactory {
        predicted: Address,
    },
    PrepareChildren {
        count: u16,
    },
    Mint {
        requested: u16,
        minimum: u16,
        factory: Option<Address>,
        minters: Vec<Address>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub hash: B256,
    pub nonce: u64,
    pub to: Option<Address>,
    pub action: Action,
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_cost_wei: u128,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub version: u8,
    pub identity: Identity,
    pub factory: Option<Address>,
    pub pending: Option<Pending>,
    pub gas_cost_wei: u128,
    /// Optional for registries written before receipt-bound reads were added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_receipt_block: Option<u64>,
}
impl Pending {
    fn validate(&self, state: &State) -> Result<()> {
        ensure!(
            self.hash != B256::ZERO
                && self.gas_limit >= 21_000
                && self.max_fee_per_gas > 0
                && self.max_cost_wei
                    == u128::from(self.gas_limit)
                        .checked_mul(self.max_fee_per_gas)
                        .ok_or_else(|| anyhow::anyhow!("GAS_COST_OVERFLOW"))?,
            "INVALID_PENDING_INTENT"
        );
        match &self.action {
            Action::DeployFactory { predicted } => ensure!(
                self.to.is_none()
                    && state.factory.is_none()
                    && *predicted == predict_create(state.identity.owner, self.nonce),
                "INVALID_SAVED_DEPLOYMENT_INTENT"
            ),
            Action::PrepareChildren { count } => ensure!(
                (1..=100).contains(count) && self.to.is_some() && self.to == state.factory,
                "INVALID_SAVED_PREPARATION_INTENT"
            ),
            Action::Mint {
                requested,
                minimum,
                factory,
                minters,
            } => {
                let unique = minters.iter().collect::<std::collections::BTreeSet<_>>();
                ensure!(
                    (1..=100).contains(requested)
                        && (1..=*requested).contains(minimum)
                        && minters.len() == usize::from(*requested)
                        && unique.len() == minters.len()
                        && !minters.contains(&Address::ZERO),
                    "INVALID_SAVED_MINT_INTENT"
                );
                if factory.is_some() {
                    ensure!(
                        *factory == state.factory && self.to == *factory,
                        "INVALID_SAVED_MINT_FACTORY"
                    );
                } else {
                    ensure!(
                        *requested == 1
                            && minters[0] == state.identity.owner
                            && self.to.is_some_and(|a| a != Address::ZERO),
                        "INVALID_SAVED_DIRECT_MINT"
                    );
                }
            }
        }
        Ok(())
    }
}

pub struct Store {
    root: PathBuf,
    pub state: State,
    _lock: Arc<File>,
}
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
fn regular(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(m) => {
            ensure!(
                m.is_file() && !m.file_type().is_symlink(),
                "UNSAFE_STATE_FILE"
            );
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => anyhow::bail!("STATE_METADATA_FAILED"),
    }
}
fn open_options() -> OpenOptions {
    let mut o = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o
}
fn private_dirs(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        private_dirs(parent)?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(m) => ensure!(
            m.is_dir() && !m.file_type().is_symlink(),
            "UNSAFE_STATE_DIRECTORY"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut b = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                b.mode(0o700);
            }
            b.create(path)
                .map_err(|_| anyhow::anyhow!("STATE_DIRECTORY_CREATE_FAILED"))?;
        }
        Err(_) => anyhow::bail!("STATE_DIRECTORY_READ_FAILED"),
    };
    Ok(())
}
impl Store {
    pub fn open(root: &Path, identity: Identity) -> Result<Self> {
        ensure!(
            root.components().count() <= 64
                && !root
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)),
            "INVALID_STATE_DIRECTORY"
        );
        private_dirs(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                std::fs::metadata(root)?.permissions().mode() & 0o077 == 0,
                "STATE_DIRECTORY_MUST_BE_PRIVATE_CHMOD_700"
            );
        }
        let lock_path = root.join("wallet.lock");
        regular(&lock_path)?;
        let lock = open_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| anyhow::anyhow!("STATE_LOCK_OPEN_FAILED"))?;
        lock.try_lock_exclusive()
            .map_err(|_| anyhow::anyhow!("WALLET_ALREADY_RUNNING"))?;
        let path = root.join("state.json");
        let state = if regular(&path)? {
            let file = File::open(&path).map_err(|_| anyhow::anyhow!("STATE_READ_FAILED"))?;
            ensure!(file.metadata()?.len() <= 65_536, "STATE_TOO_LARGE");
            let mut bytes = Vec::new();
            file.take(65_537).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 65_536, "STATE_TOO_LARGE");
            let s: State = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("CORRUPT_STATE_DO_NOT_REDEPLOY"))?;
            ensure!(
                s.version == 1 && s.identity == identity,
                "STATE_IDENTITY_MISMATCH_DO_NOT_REDEPLOY"
            );
            ensure!(s.factory != Some(Address::ZERO), "INVALID_SAVED_FACTORY");
            if let Some(pending) = &s.pending {
                pending.validate(&s)?;
            }
            s
        } else {
            State {
                version: 1,
                identity,
                factory: None,
                pending: None,
                gas_cost_wei: 0,
                last_receipt_block: None,
            }
        };
        let result = Self {
            root: root.to_owned(),
            state,
            _lock: Arc::new(lock),
        };
        result.save()?;
        Ok(result)
    }
    fn save(&self) -> Result<()> {
        let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp = self
            .root
            .join(format!(".state-{}-{id}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&self.state)?;
        ensure!(bytes.len() <= 65_536, "STATE_TOO_LARGE");
        let mut f = open_options()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| anyhow::anyhow!("STATE_WRITE_FAILED"))?;
        f.write_all(&bytes)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        regular(&self.root.join("state.json"))?;
        std::fs::rename(&temp, self.root.join("state.json"))?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }
    // Keep the process ownership lock alive in the blocking job if the async
    // caller is cancelled. This is not a mutex shared by async request tasks.
    async fn persist(&self) -> Result<()> {
        let snapshot = Self {
            root: self.root.clone(),
            state: self.state.clone(),
            _lock: Arc::clone(&self._lock),
        };
        tokio::task::spawn_blocking(move || snapshot.save())
            .await
            .map_err(|_| anyhow::anyhow!("STATE_WORKER_FAILED"))?
    }
    pub async fn intent(&mut self, pending: Pending) -> Result<()> {
        ensure!(
            self.state.pending.is_none(),
            "UNRESOLVED_TRANSACTION_RECOVER_FIRST"
        );
        pending.validate(&self.state)?;
        self.state.pending = Some(pending);
        self.persist().await
    }
    /// Caller has a validated receipt, or proves its own call was never polled.
    pub async fn resolve(
        &mut self,
        hash: B256,
        cost: u128,
        factory: Option<Address>,
        receipt_block: Option<u64>,
    ) -> Result<()> {
        let pending = self
            .state
            .pending
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NO_PENDING_TRANSACTION"))?;
        ensure!(
            pending.hash == hash && cost <= pending.max_cost_wei,
            "PENDING_RECEIPT_MISMATCH"
        );
        if let Some(address) = factory {
            ensure!(
                matches!(pending.action,Action::DeployFactory{predicted}if predicted==address),
                "FACTORY_ADDRESS_MISMATCH"
            );
        }
        let total = self
            .state
            .gas_cost_wei
            .checked_add(cost)
            .ok_or_else(|| anyhow::anyhow!("COST_OVERFLOW"))?;
        if let Some(address) = factory {
            self.state.factory = Some(address);
        }
        self.state.gas_cost_wei = total;
        if let Some(block) = receipt_block {
            self.state.last_receipt_block =
                Some(self.state.last_receipt_block.unwrap_or(0).max(block));
        }
        self.state.pending = None;
        self.persist().await
    }
    pub async fn event(&self, event: &serde_json::Value) -> Result<()> {
        let snapshot = Self {
            root: self.root.clone(),
            state: self.state.clone(),
            _lock: Arc::clone(&self._lock),
        };
        let event = event.clone();
        tokio::task::spawn_blocking(move || snapshot.event_sync(&event))
            .await
            .map_err(|_| anyhow::anyhow!("EVENT_WORKER_FAILED"))?
    }
    fn event_sync(&self, event: &serde_json::Value) -> Result<()> {
        let path = self.root.join("events.jsonl");
        regular(&path)?;
        let mut f = open_options().append(true).create(true).open(path)?;
        let bytes = serde_json::to_vec(event)?;
        ensure!(bytes.len() <= 16_384, "EVENT_TOO_LARGE");
        f.write_all(&bytes)?;
        f.write_all(b"\n")?;
        f.sync_data()?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn private_tempdir() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        directory
    }
    fn identity() -> Identity {
        Identity {
            chain_id: 4663,
            owner: Address::repeat_byte(1),
            nft: Address::repeat_byte(2),
            recipient: Address::repeat_byte(1),
            artifact_hash: B256::repeat_byte(3),
        }
    }
    fn pending() -> Pending {
        Pending {
            hash: B256::repeat_byte(4),
            nonce: 0,
            to: None,
            action: Action::DeployFactory {
                predicted: predict_create(identity().owner, 0),
            },
            gas_limit: 21_000,
            max_fee_per_gas: 2,
            max_cost_wei: 42_000,
        }
    }
    #[tokio::test]
    async fn reload_recovery_and_lock() {
        let d = private_tempdir();
        let mut s = Store::open(&d.path().canonicalize().unwrap(), identity()).unwrap();
        assert!(Store::open(&d.path().canonicalize().unwrap(), identity()).is_err());
        s.intent(pending()).await.unwrap();
        assert!(s.intent(pending()).await.is_err());
        drop(s);
        let mut s = Store::open(&d.path().canonicalize().unwrap(), identity()).unwrap();
        assert!(s.state.pending.is_some());
        assert!(s.resolve(B256::ZERO, 1, None, Some(10)).await.is_err());
        s.resolve(
            pending().hash,
            32_000,
            Some(predict_create(identity().owner, 0)),
            Some(10),
        )
        .await
        .unwrap();
        drop(s);
        let s = Store::open(&d.path().canonicalize().unwrap(), identity()).unwrap();
        assert_eq!(s.state.factory, Some(predict_create(identity().owner, 0)));
        assert_eq!(s.state.gas_cost_wei, 32_000);
        assert!(s.state.pending.is_none());
        assert_eq!(s.state.last_receipt_block, Some(10));
    }
    #[test]
    fn identity_and_corruption_fail_closed() {
        let d = private_tempdir();
        drop(Store::open(&d.path().canonicalize().unwrap(), identity()).unwrap());
        let mut other = identity();
        other.nft = Address::ZERO;
        assert!(Store::open(&d.path().canonicalize().unwrap(), other).is_err());
        std::fs::write(d.path().join("state.json"), b"invalid").unwrap();
        assert!(Store::open(&d.path().canonicalize().unwrap(), identity()).is_err());
    }
    #[tokio::test]
    async fn legacy_state_and_receipt_floor_survive_restart_and_unsent_intent() {
        let directory = private_tempdir();
        let root = directory.path().canonicalize().unwrap();
        let original = Store::open(&root, identity()).unwrap();
        let legacy = serde_json::to_value(&original.state).unwrap();
        assert!(legacy.get("last_receipt_block").is_none());
        drop(original);
        let mut store = Store::open(&root, identity()).unwrap();
        assert_eq!(store.state.last_receipt_block, None);
        store.intent(pending()).await.unwrap();
        // A reverted deployment still consumes nonce/gas at its receipt block.
        store
            .resolve(pending().hash, 30_000, None, Some(12))
            .await
            .unwrap();
        store.intent(pending()).await.unwrap();
        store.resolve(pending().hash, 0, None, None).await.unwrap();
        drop(store);
        let mut store = Store::open(&root, identity()).unwrap();
        assert_eq!(store.state.last_receipt_block, Some(12));
        store.intent(pending()).await.unwrap();
        store
            .resolve(pending().hash, 1, None, Some(11))
            .await
            .unwrap();
        drop(store);
        let store = Store::open(&root, identity()).unwrap();
        assert_eq!(store.state.last_receipt_block, Some(12));
        assert_eq!(store.state.gas_cost_wei, 30_001);
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink() {
        let d = private_tempdir();
        std::os::unix::fs::symlink("/tmp", d.path().join("state.json")).unwrap();
        assert!(Store::open(&d.path().canonicalize().unwrap(), identity()).is_err());
    }
    #[test]
    fn tampered_pending_address_and_cost_fail_closed() {
        let directory = private_tempdir();
        let root = directory.path().canonicalize().unwrap();
        let mut state = Store::open(&root, identity()).unwrap().state.clone();
        let mut intent = pending();
        intent.to = Some(Address::repeat_byte(7));
        state.pending = Some(intent.clone());
        std::fs::write(root.join("state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(Store::open(&root, identity()).is_err());
        intent.to = None;
        intent.max_cost_wei = 1;
        state.pending = Some(intent);
        std::fs::write(root.join("state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(Store::open(&root, identity()).is_err());
    }
}
