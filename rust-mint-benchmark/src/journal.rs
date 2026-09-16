use std::{
    fs::File,
    path::{Path, PathBuf},
};

use alloy_primitives::Address;
use anyhow::{Result, ensure};
use fs2::FileExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

pub struct Journal {
    root: PathBuf,
    file: tokio::fs::File,
    _lock: Option<File>,
    pending: Option<PathBuf>,
}

impl Journal {
    pub fn ensure_wallet_available(lock_dir: &Path, wallet: Address) -> Result<()> {
        let path = lock_dir.join(format!("4663-{wallet}.pending.json"));
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
            Ok(_) => anyhow::bail!(
                "Wallet has a previous unresolved run; inspect its pending marker and journal before another live run"
            ),
        }
    }

    pub async fn create(root: &Path, lock_dir: &Path, wallet: Address, live: bool) -> Result<Self> {
        let pending = live.then(|| lock_dir.join(format!("4663-{wallet}.pending.json")));
        let lock = if live {
            // Persistent lock inode: never unlink it while another process may hold an fd.
            create_private_directories(lock_dir)?;
            ensure!(
                !std::fs::symlink_metadata(lock_dir)?
                    .file_type()
                    .is_symlink(),
                "Lock directory must not be a symlink"
            );
            sync_directory(
                lock_dir
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new(".")),
            )?;
            let path = lock_dir.join(format!("4663-{wallet}.lock"));
            if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "Unsafe wallet lock file"
                );
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(path)?;
            file.try_lock_exclusive()
                .map_err(|_| anyhow::anyhow!("Another test holds this wallet lock"))?;
            Self::ensure_wallet_available(lock_dir, wallet)?;
            Some(file)
        } else {
            None
        };
        tokio::fs::create_dir(root).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let file = options.open(root.join("journal.jsonl")).await?;
        sync_directory(root)?;
        sync_directory(
            root.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        Ok(Self {
            root: root.to_owned(),
            file,
            _lock: lock,
            pending,
        })
    }

    pub async fn append(&mut self, value: Value) -> Result<()> {
        if value["type"] == "intent"
            && let Some(path) = &self.pending
            && !path.exists()
        {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options.mode(0o600);
            }
            let mut marker = options.open(path).await?;
            let body = serde_json::json!({"reportDirectory":std::fs::canonicalize(&self.root)?,"action":"Reconcile every prepared hash and wallet nonce before manually clearing this marker. Never blindly retry."});
            marker.write_all(&serde_json::to_vec_pretty(&body)?).await?;
            marker.sync_all().await?;
            sync_directory(
                path.parent()
                    .ok_or_else(|| anyhow::anyhow!("Missing marker directory"))?,
            )?;
        }
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        self.file.write_all(&bytes).await?;
        self.file.sync_data().await?;
        Ok(())
    }

    pub async fn save(&self, name: &str, value: &Value) -> Result<()> {
        ensure!(
            name.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
            "Invalid report filename"
        );
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(self.root.join(name)).await?;
        file.write_all(&serde_json::to_vec_pretty(value)?).await?;
        file.write_all(b"\n").await?;
        file.sync_all().await?;
        sync_directory(&self.root)?;
        Ok(())
    }

    /// Only after the complete report and finished journal record are durable.
    pub async fn mark_resolved(&mut self) -> Result<()> {
        if let Some(path) = &self.pending {
            tokio::fs::remove_file(path).await?;
            sync_directory(
                path.parent()
                    .ok_or_else(|| anyhow::anyhow!("Missing marker directory"))?,
            )?;
        }
        Ok(())
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn create_private_directories(path: &Path) -> Result<()> {
    let mut missing = Vec::new();
    let mut cursor = path;
    loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_dir() && !metadata.file_type().is_symlink(),
                    "Unsafe lock directory ancestor"
                );
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ensure!(missing.len() < 256, "Lock directory depth exceeds limit");
                missing.push(cursor.to_owned());
                cursor = cursor
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
            }
            Err(error) => return Err(error.into()),
        }
    }
    for directory in missing.iter().rev() {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
        sync_directory(
            directory
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
    }
    Ok(())
}
