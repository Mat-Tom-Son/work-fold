//! Same-user, cross-process exclusion for work-fold's physical input seat.
//! An advisory OS lock coordinates our own hosts; it is not a security boundary
//! against native full-trust Extensions or other desktop applications.
use anyhow::{ensure, Context, Result};
use std::{fs::{File, OpenOptions}, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path};

pub struct SeatLease { _file: File }
impl SeatLease {
    pub fn acquire(runtime_dir: &Path) -> Result<Self> {
        let directory = std::fs::symlink_metadata(runtime_dir)?;
        let uid = unsafe { libc::geteuid() };
        ensure!(directory.is_dir() && directory.uid() == uid && directory.mode() & 0o077 == 0,
            "Physical input requires a private, owned XDG_RUNTIME_DIR");
        let file = OpenOptions::new().read(true).write(true).create(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(runtime_dir.join("work-fold-wayland-seat.lock"))?;
        let metadata = file.metadata()?;
        ensure!(metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o077 == 0 && metadata.nlink() == 1,
            "Invalid physical-seat coordination file");
        file.try_lock().context("Another work-fold turn is using this desktop seat")?;
        // Never unlink the file: all processes must lock the same inode.
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn private_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }
    #[test]
    fn independent_handles_exclude_each_other_and_release_on_drop() {
        let dir = private_dir();
        let first = SeatLease::acquire(dir.path()).unwrap();
        assert!(SeatLease::acquire(dir.path()).is_err());
        drop(first);
        assert!(SeatLease::acquire(dir.path()).is_ok());
    }
    #[test]
    fn symlink_and_shared_directory_cannot_redirect_the_lock() {
        use std::os::unix::fs::symlink;
        let dir = private_dir();
        let target = dir.path().join("unrelated");
        std::fs::write(&target, "preserve").unwrap();
        symlink(&target, dir.path().join("work-fold-wayland-seat.lock")).unwrap();
        assert!(SeatLease::acquire(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "preserve");
        std::fs::remove_file(dir.path().join("work-fold-wayland-seat.lock")).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(SeatLease::acquire(dir.path()).is_err());
    }
}
