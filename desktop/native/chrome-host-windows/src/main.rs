//! work-fold's Windows Chrome native messaging bootstrap.
//!
//! The Windows counterpart of `desktop/native/chrome-bootstrap.swift`. Chrome
//! starts it for one message from the work-fold Store extension. It accepts
//! only the Store origin baked in at build time, reads one bounded framed
//! request and relays it to the running app's loopback endpoint named by the
//! owner-only `launch.json` beside this executable. It never mutates connection
//! state or controls Chrome.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const MAXIMUM_REQUEST_BYTES: usize = 16 * 1024;
const MAXIMUM_RESPONSE_BYTES: usize = 64 * 1024;
const MAXIMUM_RESPONSE_HEAD_BYTES: usize = 8 * 1024;
const ORIGIN: &str = match option_env!("WORKFOLD_CHROME_ORIGIN") {
    Some(origin) => origin,
    None => "",
};
const APP_EXECUTABLE_NAME: &str = "work-fold.exe";

fn main() {
    if ORIGIN.is_empty() {
        fail("store_unavailable");
    }
    let arguments: Vec<OsString> = std::env::args_os().collect();
    if !caller_is_store_extension(&arguments) {
        fail("connection_error");
    }
    // A truncated client must not leave an orphaned native helper process forever.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(1);
    });
    let request = read_request().unwrap_or_else(|| fail("connection_error"));
    let directory = own_directory().unwrap_or_else(|| fail("connection_error"));
    if request.get("version").and_then(Value::as_i64) == Some(1)
        && request.get("action").and_then(Value::as_str) == Some("open-app")
    {
        fail(if open_app(&directory) { "connecting" } else { "app_not_running" });
    }
    let descriptor = private_json(&directory.join("launch.json")).unwrap_or_else(|| fail("app_not_running"));
    let (launch_id, token, port) = launch_descriptor(&descriptor).unwrap_or_else(|| fail("app_not_running"));
    let envelope = json!({ "version": 1, "launchId": launch_id, "extensionOrigin": ORIGIN, "request": request });
    let payload = serde_json::to_vec(&envelope).unwrap_or_else(|_| fail("connection_error"));
    match post_bootstrap(port, &token, &payload) {
        Some(answer) => {
            write_frame(&answer);
            std::process::exit(0);
        }
        None => fail("app_not_running"),
    }
}

/// Chrome passes the caller origin as the first argument. On Windows it also
/// passes the calling browser window; it never passes a profile identity.
fn caller_is_store_extension(arguments: &[OsString]) -> bool {
    let origin_matches = arguments.get(1).is_some_and(|value| value.as_os_str() == ORIGIN);
    match arguments.len() {
        2 => origin_matches,
        3 => origin_matches
            && arguments[2]
                .to_str()
                .and_then(|value| value.strip_prefix("--parent-window="))
                .is_some_and(|window| !window.is_empty() && window.len() <= 20 && window.bytes().all(|byte| byte.is_ascii_digit())),
        _ => false,
    }
}

fn read_request() -> Option<Value> {
    let mut input = std::io::stdin().lock();
    let mut header = [0u8; 4];
    input.read_exact(&mut header).ok()?;
    let count = u32::from_le_bytes(header) as usize;
    if count == 0 || count > MAXIMUM_REQUEST_BYTES {
        return None;
    }
    let mut body = vec![0u8; count];
    input.read_exact(&mut body).ok()?;
    match serde_json::from_slice(&body).ok()? {
        value @ Value::Object(_) => Some(value),
        _ => None,
    }
}

fn own_directory() -> Option<PathBuf> {
    let executable = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    Some(executable.parent()?.to_path_buf())
}

fn write_frame(value: &Value) {
    let bytes = match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= MAXIMUM_RESPONSE_BYTES => bytes,
        _ => std::process::exit(1),
    };
    let mut output = std::io::stdout().lock();
    let _ = output.write_all(&(bytes.len() as u32).to_le_bytes());
    let _ = output.write_all(&bytes);
    let _ = output.flush();
}

fn fail(state: &str) -> ! {
    write_frame(&json!({ "version": 1, "state": "status", "status": { "state": state, "checkedAt": iso8601_now() } }));
    std::process::exit(0);
}

fn private_json(path: &Path) -> Option<Value> {
    match serde_json::from_slice(&private_file::read(path, MAXIMUM_REQUEST_BYTES)?).ok()? {
        value @ Value::Object(_) => Some(value),
        _ => None,
    }
}

fn launch_descriptor(descriptor: &Value) -> Option<(String, String, u16)> {
    if descriptor.get("version").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let launch_id = descriptor.get("launchId")?.as_str()?;
    let token = descriptor.get("bootstrapToken")?.as_str()?;
    let endpoint = descriptor.get("endpoint")?.as_str()?;
    if !is_uuid(launch_id) || token.len() != 64 || !token.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let port: u16 = endpoint.strip_prefix("http://127.0.0.1:")?.strip_suffix("/bootstrap")?.parse().ok()?;
    // Only the exact canonical loopback endpoint is admitted.
    if port == 0 || endpoint != format!("http://127.0.0.1:{port}/bootstrap") {
        return None;
    }
    Some((launch_id.to_string(), token.to_string(), port))
}

fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// One direct loopback POST: no proxy, cookies or redirects, bounded in size and time.
/// HTTP/1.0 keeps Node from chunking the reply; the closed connection ends the body.
fn post_bootstrap(port: u16, token: &str, payload: &[u8]) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_secs(6);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let head = format!(
        "POST /bootstrap HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(payload).ok()?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now()).filter(|remaining| !remaining.is_zero())?;
        stream.set_read_timeout(Some(remaining)).ok()?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if response.len() > MAXIMUM_RESPONSE_BYTES + MAXIMUM_RESPONSE_HEAD_BYTES {
                    return None;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    let split = response.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..split]).ok()?;
    let body = &response[split + 4..];
    let mut lines = head.split("\r\n");
    let mut status = lines.next()?.splitn(3, ' ');
    if !status.next()?.starts_with("HTTP/1.") || status.next()? != "200" {
        return None;
    }
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = Some(value.trim().parse::<usize>().ok()?),
            // An HTTP/1.0 reply is never chunked; any transfer coding is refused.
            "transfer-encoding" => return None,
            _ => {}
        }
    }
    if length.is_some_and(|length| length != body.len()) || body.len() > MAXIMUM_RESPONSE_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(body).ok()?;
    (value.is_object() && value.get("version").and_then(Value::as_i64) == Some(1)).then_some(value)
}

/// Starts the installed app named by the owner-only `app.json` the app wrote at
/// registration. Its own single-instance lock handles an already running copy.
fn open_app(directory: &Path) -> bool {
    let Some(record) = private_json(&directory.join("app.json")) else { return false };
    if record.get("version").and_then(Value::as_i64) != Some(1) {
        return false;
    }
    let Some(executable) = record.get("executable").and_then(Value::as_str).map(PathBuf::from) else { return false };
    if !executable.is_absolute() || !executable.file_name().is_some_and(|name| name.eq_ignore_ascii_case(APP_EXECUTABLE_NAME)) {
        return false;
    }
    launch_detached(&executable)
}

#[cfg(windows)]
fn launch_detached(executable: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let spawn = |flags: u32| {
        Command::new(executable)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | flags)
            .spawn()
            .is_ok()
    };
    // Leave Chrome's host job when it allows that, so the app outlives this helper.
    spawn(CREATE_BREAKAWAY_FROM_JOB) || spawn(0)
}

#[cfg(not(windows))]
fn launch_detached(executable: &Path) -> bool {
    Command::new(executable).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok()
}

fn iso8601_now() -> String {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let time = seconds.rem_euclid(86_400);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", time / 3600, time % 3600 / 60, time % 60)
}

/// Proleptic Gregorian date for days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 } as u32;
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// The Windows equivalent of the macOS `O_NOFOLLOW` + owner + `mode & 0o077 == 0`
/// check: a single-link regular file owned by this user whose DACL allows only
/// this user, SYSTEM and Administrators. The bytes come from the checked handle,
/// which shares delete access so the app can still atomically replace the file.
#[cfg(windows)]
mod private_file {
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AclSizeInformation, CreateWellKnownSid, EqualSid, GetAce, GetAclInformation, GetTokenInformation, TokenUser, WinBuiltinAdministratorsSid,
        WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const MAXIMUM_SID_BYTES: usize = 68;

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0 as _) };
        }
    }

    pub fn read(path: &Path, limit: usize) -> Option<Vec<u8>> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(wide.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut())
        };
        if raw == INVALID_HANDLE_VALUE {
            return None;
        }
        let handle = Handle(raw);
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut information) } == 0 {
            return None;
        }
        let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
        if information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || information.nNumberOfLinks != 1
            || size == 0
            || size > limit as u64
            || !owner_only(handle.0)?
        {
            return None;
        }
        let file = unsafe { std::fs::File::from_raw_handle(handle.0 as _) };
        std::mem::forget(handle);
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes).ok()?;
        (!bytes.is_empty() && bytes.len() <= limit).then_some(bytes)
    }

    fn owner_only(file: HANDLE) -> Option<bool> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut security: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &mut owner, null_mut(), &mut dacl, null_mut(), &mut security)
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let _security = Descriptor(security);
        let user = current_user()?;
        let user_sid = user.as_ptr() as PSID;
        // A NULL DACL grants everyone full access.
        if owner.is_null() || dacl.is_null() || unsafe { EqualSid(owner, user_sid) } == 0 {
            return Some(false);
        }
        let system = well_known(WinLocalSystemSid)?;
        let administrators = well_known(WinBuiltinAdministratorsSid)?;
        let mut size: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetAclInformation(dacl, &mut size as *mut _ as _, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 {
            return None;
        }
        for index in 0..size.AceCount {
            let mut ace: *mut core::ffi::c_void = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return None;
            }
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            if header.AceFlags & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            match header.AceType {
                ACCESS_ALLOWED_ACE_TYPE => {
                    let sid = unsafe { &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID };
                    let admitted = [user_sid, system.as_ptr() as PSID, administrators.as_ptr() as PSID].iter().any(|allowed| unsafe { EqualSid(sid, *allowed) } != 0);
                    if !admitted {
                        return Some(false);
                    }
                }
                ACCESS_DENIED_ACE_TYPE => {}
                // Object, callback and conditional grants are never admitted.
                _ => return Some(false),
            }
        }
        Some(true)
    }

    fn current_user() -> Option<Vec<u8>> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = Handle(token);
        let mut length = 0u32;
        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length) };
        if length == 0 || length > 4096 {
            return None;
        }
        let mut buffer = vec![0u8; length as usize];
        if unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr() as _, length, &mut length) } == 0 {
            return None;
        }
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        let sid = user.User.Sid;
        let sid_length = unsafe { windows_sys::Win32::Security::GetLengthSid(sid) } as usize;
        if sid_length == 0 || sid_length > MAXIMUM_SID_BYTES {
            return None;
        }
        Some(unsafe { std::slice::from_raw_parts(sid as *const u8, sid_length) }.to_vec())
    }

    fn well_known(kind: windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE) -> Option<Vec<u8>> {
        let mut buffer = vec![0u8; MAXIMUM_SID_BYTES];
        let mut length = buffer.len() as u32;
        if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr() as PSID, &mut length) } == 0 {
            return None;
        }
        buffer.truncate(length as usize);
        Some(buffer)
    }
}

#[cfg(not(windows))]
mod private_file {
    /// This bootstrap is built for Windows only; elsewhere nothing is admitted.
    pub fn read(_path: &std::path::Path, _limit: usize) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_follow_the_gregorian_calendar() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_729), (2026, 10, 3));
    }

    #[test]
    fn only_the_canonical_loopback_endpoint_is_admitted() {
        let token = "a".repeat(64);
        let descriptor = |endpoint: &str| json!({ "version": 1, "launchId": "8c1d6a0e-2f4b-4c7a-9e3d-1a2b3c4d5e6f", "bootstrapToken": token, "endpoint": endpoint });
        assert_eq!(launch_descriptor(&descriptor("http://127.0.0.1:4100/bootstrap")).map(|value| value.2), Some(4100));
        for endpoint in [
            "http://127.0.0.1:04100/bootstrap",
            "http://127.0.0.1:0/bootstrap",
            "http://localhost:4100/bootstrap",
            "https://127.0.0.1:4100/bootstrap",
            "http://127.0.0.1:4100/bootstrap?x=1",
            "http://127.0.0.1:70000/bootstrap",
        ] {
            assert!(launch_descriptor(&descriptor(endpoint)).is_none(), "{endpoint}");
        }
        assert!(launch_descriptor(&json!({ "version": 1, "launchId": "not-a-uuid", "bootstrapToken": token, "endpoint": "http://127.0.0.1:4100/bootstrap" })).is_none());
        assert!(launch_descriptor(&json!({ "version": 1, "launchId": "8c1d6a0e-2f4b-4c7a-9e3d-1a2b3c4d5e6f", "bootstrapToken": "A".repeat(64), "endpoint": "http://127.0.0.1:4100/bootstrap" })).is_none());
    }
}
