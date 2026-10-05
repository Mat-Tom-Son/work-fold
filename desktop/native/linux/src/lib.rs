use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

pub fn private_json(path: &Path, limit: u64) -> io::Result<Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file()
        || info.uid() != unsafe { libc::getuid() }
        || info.mode() & 0o077 != 0
        || info.len() > limit
    {
        return Err(io::Error::other(
            "Expected a bounded, private, user-owned file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("File exceeds limit"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() || info.uid() != unsafe { libc::getuid() } {
        return Err(io::Error::other("Expected a user-owned directory"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

pub fn atomic_json(path: &Path, value: &Value) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        // A fresh UUID names every request; never replace an existing request.
        fs::hard_link(&temporary, path)?;
        File::open(path.parent().unwrap())?.sync_all()
    })();
    let _ = fs::remove_file(temporary);
    result
}

pub fn environment(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}
