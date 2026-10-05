//! Own libei's sender context; libei owns the protocol and device lifecycle.
//! No global socket discovery, seat fallback, or input on connection alone.
use crate::keyboard::Keyboard;
use anyhow::{anyhow, ensure, Context, Result};
use std::{
    collections::HashMap,
    ffi::CStr,
    marker::PhantomData,
    os::{
        fd::{BorrowedFd, IntoRawFd, OwnedFd},
        unix::fs::FileExt,
    },
    ptr::NonNull,
    rc::Rc,
};

#[allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    dead_code
)]
pub(crate) mod ffi {
    include!(concat!(env!("OUT_DIR"), "/ei_bindings.rs"));
}

#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    pub mapping_id: Option<String>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub physical_scale: f64,
}

struct Device {
    raw: NonNull<ffi::ei_device>,
    generation: u64,
    resumed: bool,
    emulating: bool,
    keyboard: Option<Keyboard>,
}

struct HeldButton {
    device: *mut ffi::ei_device,
    context: *mut ffi::ei,
    button: u32,
    _thread: PhantomData<Rc<()>>,
}
impl Drop for HeldButton {
    fn drop(&mut self) {
        unsafe {
            ffi::ei_device_button_button(self.device, self.button, false);
            ffi::ei_device_frame(self.device, ffi::ei_now(self.context));
            ffi::ei_dispatch(self.context);
            ffi::ei_device_unref(self.device);
            ffi::ei_unref(self.context);
        }
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            ffi::ei_device_unref(self.raw.as_ptr());
        }
    }
}

pub struct Sender {
    raw: NonNull<ffi::ei>,
    devices: HashMap<usize, Device>,
    connected: bool,
    sequence: u32,
    device_generation: u64,
    pointer_bindings: HashMap<String, usize>,
    // C context access stays on its creating thread, even under a Tokio runtime.
    _thread: PhantomData<Rc<()>>,
}

impl Sender {
    pub fn new(fd: OwnedFd) -> Result<Self> {
        let raw = NonNull::new(unsafe { ffi::ei_new_sender(std::ptr::null_mut()) })
            .context("Cannot allocate libei sender")?;
        let sender = Self {
            raw,
            devices: HashMap::new(),
            connected: false,
            sequence: 0,
            device_generation: 0,
            pointer_bindings: HashMap::new(),
            _thread: PhantomData,
        };
        unsafe {
            ffi::ei_configure_name(raw.as_ptr(), c"work-fold".as_ptr());
            // libei takes ownership and closes this descriptor, including failure.
            ensure!(
                ffi::ei_setup_backend_fd(raw.as_ptr(), fd.into_raw_fd()) == 0,
                "Cannot connect libei to the granted descriptor"
            );
        }
        Ok(sender)
    }

    pub fn dispatch(&mut self) -> Result<()> {
        unsafe {
            ffi::ei_dispatch(self.raw.as_ptr());
        }
        for _ in 0..256 {
            let Some(event) = NonNull::new(unsafe { ffi::ei_get_event(self.raw.as_ptr()) }) else {
                return Ok(());
            };
            let result = self.event(event.as_ptr());
            unsafe {
                ffi::ei_event_unref(event.as_ptr());
            }
            result?;
        }
        Err(anyhow!("Too many pending input device events"))
    }

    fn event(&mut self, event: *mut ffi::ei_event) -> Result<()> {
        unsafe {
            if std::env::var("WORKFOLD_ISOLATED_GNOME_TEST").as_deref() == Ok("1") {
                eprintln!("Isolated EI event type: {}", ffi::ei_event_get_type(event));
            }
            match ffi::ei_event_get_type(event) {
                ffi::EI_EVENT_CONNECT => self.connected = true,
                ffi::EI_EVENT_DISCONNECT => {
                    self.connected = false;
                    self.devices.clear();
                    return Err(anyhow!(
                        "EIS disconnected; close sharing and request a new session"
                    ));
                }
                ffi::EI_EVENT_SEAT_ADDED => {
                    let seat = ffi::ei_event_get_seat(event);
                    ensure!(!seat.is_null(), "Missing EIS seat");
                    ffi::ei_seat_bind_capabilities(
                        seat,
                        ffi::EI_DEVICE_CAP_POINTER_ABSOLUTE,
                        ffi::EI_DEVICE_CAP_BUTTON,
                        ffi::EI_DEVICE_CAP_SCROLL,
                        ffi::EI_DEVICE_CAP_KEYBOARD,
                        std::ptr::null::<std::ffi::c_void>(),
                    );
                }
                ffi::EI_EVENT_DEVICE_ADDED => {
                    ensure!(self.devices.len() < 32, "Too many EIS devices");
                    let ptr = ffi::ei_event_get_device(event);
                    if std::env::var("WORKFOLD_ISOLATED_GNOME_TEST").as_deref() == Ok("1") {
                        eprintln!("Isolated EI device capabilities: pointer={} keyboard={} button={} scroll={}",
                            ffi::ei_device_has_capability(ptr, ffi::EI_DEVICE_CAP_POINTER_ABSOLUTE),
                            ffi::ei_device_has_capability(ptr, ffi::EI_DEVICE_CAP_KEYBOARD),
                            ffi::ei_device_has_capability(ptr, ffi::EI_DEVICE_CAP_BUTTON),
                            ffi::ei_device_has_capability(ptr, ffi::EI_DEVICE_CAP_SCROLL));
                    }
                    ensure!(
                        ffi::ei_device_get_type(ptr) == ffi::EI_DEVICE_TYPE_VIRTUAL,
                        "Physical EIS devices are unsupported"
                    );
                    let keymap = if ffi::ei_device_has_capability(ptr, ffi::EI_DEVICE_CAP_KEYBOARD)
                    {
                        ffi::ei_device_keyboard_get_keymap(ptr)
                    } else {
                        std::ptr::null_mut()
                    };
                    let keyboard = if keymap.is_null() {
                        None
                    } else {
                        ensure!(
                            ffi::ei_keymap_get_type(keymap) == ffi::EI_KEYMAP_TYPE_XKB,
                            "Unsupported EIS keymap format"
                        );
                        let size = ffi::ei_keymap_get_size(keymap) as usize;
                        ensure!(size > 0 && size <= 1024 * 1024, "Invalid EIS keymap size");
                        let fd = ffi::ei_keymap_get_fd(keymap);
                        ensure!(fd >= 0, "Missing EIS keymap descriptor");
                        let owned = BorrowedFd::borrow_raw(fd).try_clone_to_owned()?;
                        let mut bytes = vec![0; size];
                        std::fs::File::from(owned).read_exact_at(&mut bytes, 0)?;
                        Some(Keyboard::parse(&bytes)?)
                    };
                    let raw =
                        NonNull::new(ffi::ei_device_ref(ptr)).context("Missing EIS device")?;
                    self.device_generation = self.device_generation.checked_add(1)
                        .context("Input device generation exhausted")?;
                    self.devices.insert(
                        ptr as usize,
                        Device {
                            raw,
                            generation: self.device_generation,
                            resumed: false,
                            emulating: false,
                            keyboard,
                        },
                    );
                }
                ffi::EI_EVENT_DEVICE_REMOVED => {
                    self.devices
                        .remove(&(ffi::ei_event_get_device(event) as usize));
                }
                ffi::EI_EVENT_DEVICE_PAUSED | ffi::EI_EVENT_DEVICE_RESUMED => {
                    if let Some(device) = self
                        .devices
                        .get_mut(&(ffi::ei_event_get_device(event) as usize))
                    {
                        device.resumed =
                            ffi::ei_event_get_type(event) == ffi::EI_EVENT_DEVICE_RESUMED;
                    }
                }
                ffi::EI_EVENT_KEYBOARD_MODIFIERS => {
                    if let Some(keyboard) = self
                        .devices
                        .get_mut(&(ffi::ei_event_get_device(event) as usize))
                        .and_then(|d| d.keyboard.as_mut())
                    {
                        keyboard.modifiers = [
                            ffi::ei_event_keyboard_get_xkb_mods_depressed(event),
                            ffi::ei_event_keyboard_get_xkb_mods_latched(event),
                            ffi::ei_event_keyboard_get_xkb_mods_locked(event),
                            ffi::ei_event_keyboard_get_xkb_group(event),
                        ];
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn regions(&self) -> Result<Vec<Region>> {
        let mut result = Vec::new();
        for device in self.devices.values().filter(|d| d.resumed) {
            unsafe {
                if !ffi::ei_device_has_capability(
                    device.raw.as_ptr(),
                    ffi::EI_DEVICE_CAP_POINTER_ABSOLUTE,
                ) {
                    continue;
                }
                for index in 0..32 {
                    let region = ffi::ei_device_get_region(device.raw.as_ptr(), index);
                    if region.is_null() {
                        break;
                    }
                    let mapping = ffi::ei_region_get_mapping_id(region);
                    let mapping_id = if mapping.is_null() {
                        None
                    } else {
                        let value = CStr::from_ptr(mapping).to_str()?;
                        ensure!(value.len() <= 1024, "Oversized EIS mapping id");
                        Some(value.to_owned())
                    };
                    let region = Region {
                        mapping_id,
                        x: ffi::ei_region_get_x(region),
                        y: ffi::ei_region_get_y(region),
                        width: ffi::ei_region_get_width(region),
                        height: ffi::ei_region_get_height(region),
                        physical_scale: ffi::ei_region_get_physical_scale(region),
                    };
                    ensure!(
                        region.width > 0
                            && region.height > 0
                            && region.physical_scale.is_finite()
                            && region.physical_scale > 0.0,
                        "Invalid EIS region geometry"
                    );
                    // libei explicitly permits duplicate mapping IDs during
                    // device changes. Identical geometry describes one stream;
                    // conflicting geometry must remain visible and fail closed.
                    if !result.contains(&region) {
                        result.push(region);
                    }
                }
            }
        }
        Ok(result)
    }

    pub fn ready(&self) -> bool {
        self.connected && self.devices.values().any(|d| d.resumed)
    }

    pub fn ready_for(&self, pointer: bool, keyboard: bool) -> bool {
        self.ready() && (!pointer || self.devices.values().any(|d| d.resumed && unsafe {
            ffi::ei_device_has_capability(d.raw.as_ptr(), ffi::EI_DEVICE_CAP_POINTER_ABSOLUTE)
        })) && (!keyboard || self.devices.values().any(|d| d.resumed && d.keyboard.is_some()))
    }

    fn keyboard(&self) -> Result<&Keyboard> {
        let keyboards: Vec<_> = self.devices.values().filter(|d| d.resumed)
            .filter_map(|d| d.keyboard.as_ref()).collect();
        ensure!(keyboards.len() == 1, "Require exactly one resumed compositor keymap");
        Ok(keyboards[0])
    }

    pub fn validate_text(&self, text: &str) -> Result<()> { self.keyboard()?.text(text)?; Ok(()) }
    pub fn validate_shortcut(&self, keys: &[String]) -> Result<()> { self.keyboard()?.shortcut(keys)?; Ok(()) }

    pub async fn drag(&mut self, mapping_id: &str, path: &[(f64, f64)]) -> Result<()> {
        ensure!((2..=64).contains(&path.len()), "Use 2 to 64 drag points");
        self.dispatch()?;
        // Validate the complete path before the first event, then pin its device.
        let mut checked = Vec::with_capacity(path.len());
        for (x, y) in path { checked.push(self.pointer(mapping_id, *x, *y)?); }
        let device = checked[0].0;
        ensure!(checked.iter().all(|p| p.0 == device) && unsafe {
            ffi::ei_device_has_capability(device, ffi::EI_DEVICE_CAP_BUTTON)
        }, "Drag requires one mapped button device");
        self.move_absolute(mapping_id, path[0].0, path[0].1)?;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.dispatch()?;
        ensure!(self.pointer(mapping_id, path[0].0, path[0].1)?.0 == device, "Drag device changed");
        self.emulate(device)?;
        let held = unsafe {
            let guard = HeldButton { device: ffi::ei_device_ref(device),
                context: ffi::ei_ref(self.raw.as_ptr()), button: 272, _thread: PhantomData };
            ffi::ei_device_button_button(device, 272, true);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            ffi::ei_dispatch(self.raw.as_ptr());
            guard
        };
        for ((x, y), (_, dx, dy)) in path.iter().zip(checked.iter()).skip(1) {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            self.dispatch()?;
            ensure!(self.pointer(mapping_id, *x, *y)? == (device, *dx, *dy), "Drag geometry changed");
            unsafe {
                ffi::ei_device_pointer_motion_absolute(device, *dx, *dy);
                ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
                ffi::ei_dispatch(self.raw.as_ptr());
            }
        }
        drop(held); // Also releases on error, cancellation or task drop.
        Ok(())
    }

    fn pointer(
        &mut self,
        mapping_id: &str,
        x: f64,
        y: f64,
    ) -> Result<(*mut ffi::ei_device, f64, f64)> {
        ensure!(
            x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0,
            "Invalid input coordinates"
        );
        let mut matches = Vec::new();
        for (identity, device) in self.devices.iter().filter(|(_, d)| d.resumed) {
            unsafe {
                if !ffi::ei_device_has_capability(
                    device.raw.as_ptr(),
                    ffi::EI_DEVICE_CAP_POINTER_ABSOLUTE,
                ) {
                    continue;
                }
                for index in 0..=32 {
                    let region = ffi::ei_device_get_region(device.raw.as_ptr(), index);
                    if region.is_null() {
                        break;
                    }
                    ensure!(index < 32, "Too many EIS device regions");
                    let mapping = ffi::ei_region_get_mapping_id(region);
                    if !mapping.is_null()
                        && CStr::from_ptr(mapping).to_bytes() == mapping_id.as_bytes()
                    {
                        let scale = ffi::ei_region_get_physical_scale(region);
                        ensure!(scale.is_finite() && scale > 0.0, "Invalid EIS region scale");
                        matches.push((
                            *identity,
                            device.raw.as_ptr(),
                            ffi::ei_region_get_x(region),
                            ffi::ei_region_get_y(region),
                            ffi::ei_region_get_width(region),
                            ffi::ei_region_get_height(region),
                            scale.to_bits(),
                            device.generation,
                        ));
                    }
                }
            }
        }
        ensure!(
            !matches.is_empty(),
            "Shared stream has no resumed input region"
        );
        // Mutter 46 can advertise an initial pointer before processing our
        // capability binding, followed by its negotiated equivalent. Select
        // the newest fully resumed alias deterministically, then pin it. Never
        // silently migrate an already-used target to a replacement device.
        matches.sort_by_key(|entry| std::cmp::Reverse(entry.7));
        let first = matches[0];
        ensure!(matches.iter().all(|m| (m.2,m.3,m.4,m.5,m.6) == (first.2,first.3,first.4,first.5,first.6)),
            "Shared stream has conflicting input region geometry");
        ensure!(
            self.pointer_bindings.len() < 32 || self.pointer_bindings.contains_key(mapping_id),
            "Too many bound input regions"
        );
        let identity = *self
            .pointer_bindings
            .entry(mapping_id.to_owned())
            .or_insert(first.0);
        let (_, device, left, top, width, height, _, _) =
            matches.into_iter().find(|m| m.0 == identity).context(
                "The selected pointer device changed; observe through a new sharing session",
            )?;
        ensure!(
            x < f64::from(width) && y < f64::from(height),
            "Input is outside the shared region"
        );
        Ok((device, f64::from(left) + x, f64::from(top) + y))
    }

    // An emulation sequence follows the accepted turn, not each event. In
    // particular a move and its subsequent click must retain pointer focus.
    fn emulate(&mut self, device: *mut ffi::ei_device) -> Result<()> {
        let state = self.devices.get(&(device as usize)).context("Input device disappeared")?;
        ensure!(state.resumed, "Input device is paused");
        if state.emulating { return Ok(()); }
        let sequence = self.next_sequence()?;
        unsafe { ffi::ei_device_start_emulating(device, sequence); }
        self.devices.get_mut(&(device as usize)).unwrap().emulating = true;
        Ok(())
    }

    pub fn begin_sequence(&mut self) -> Result<()> {
        self.dispatch()?;
        let devices: Vec<_> = self.devices.values().filter(|d| d.resumed).map(|d| d.raw.as_ptr()).collect();
        for device in devices { self.emulate(device)?; }
        unsafe { ffi::ei_dispatch(self.raw.as_ptr()); }
        Ok(())
    }

    pub fn end_sequence(&mut self) {
        for device in self.devices.values_mut() {
            if device.emulating && device.resumed { unsafe { ffi::ei_device_stop_emulating(device.raw.as_ptr()); } }
            device.emulating = false;
        }
        unsafe { ffi::ei_dispatch(self.raw.as_ptr()); }
    }

    fn next_sequence(&mut self) -> Result<u32> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .context("EIS sequence exhausted; reconnect")?;
        Ok(self.sequence)
    }

    pub fn move_absolute(&mut self, mapping_id: &str, x: f64, y: f64) -> Result<()> {
        self.dispatch()?;
        let (device, x, y) = self.pointer(mapping_id, x, y)?;
        self.emulate(device)?;
        unsafe {
            ffi::ei_device_pointer_motion_absolute(device, x, y);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            ffi::ei_dispatch(self.raw.as_ptr());
        }
        Ok(())
    }

    /// All validation precedes the first event. No waits or fallible allocation
    /// occur while a button is held; every press has a matching release frame.
    pub fn click(
        &mut self,
        mapping_id: &str,
        x: f64,
        y: f64,
        button: u32,
        count: u8,
    ) -> Result<()> {
        ensure!(
            (272..=274).contains(&button) && (1..=3).contains(&count),
            "Unsupported pointer button or click count"
        );
        self.dispatch()?;
        let (device, x, y) = self.pointer(mapping_id, x, y)?;
        ensure!(
            unsafe { ffi::ei_device_has_capability(device, ffi::EI_DEVICE_CAP_BUTTON) },
            "Mapped pointer has no button capability"
        );
        self.emulate(device)?;
        unsafe {
            ffi::ei_device_pointer_motion_absolute(device, x, y);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            for _ in 0..count {
                ffi::ei_device_button_button(device, button, true);
                ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
                ffi::ei_device_button_button(device, button, false);
                ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            }
            ffi::ei_dispatch(self.raw.as_ptr());
        }
        Ok(())
    }

    pub fn scroll(&mut self, mapping_id: &str, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        ensure!(
            dx.is_finite()
                && dy.is_finite()
                && dx.abs() <= 10_000.0
                && dy.abs() <= 10_000.0
                && (dx != 0.0 || dy != 0.0),
            "Invalid bounded scroll delta"
        );
        self.dispatch()?;
        let (device, x, y) = self.pointer(mapping_id, x, y)?;
        ensure!(
            unsafe { ffi::ei_device_has_capability(device, ffi::EI_DEVICE_CAP_SCROLL) },
            "Mapped pointer has no scroll capability"
        );
        self.emulate(device)?;
        unsafe {
            ffi::ei_device_pointer_motion_absolute(device, x, y);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            ffi::ei_device_scroll_delta(device, dx, dy);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            ffi::ei_device_scroll_stop(device, dx != 0.0, dy != 0.0);
            ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            ffi::ei_dispatch(self.raw.as_ptr());
        }
        Ok(())
    }

    /// EVDEV codes come only from the negotiated compositor keymap.
    pub fn shortcut(&mut self, names: &[String]) -> Result<()> {
        self.dispatch()?;
        let keyboards: Vec<_> = self
            .devices
            .values()
            .filter(|d| d.resumed && d.keyboard.is_some())
            .collect();
        ensure!(
            keyboards.len() == 1,
            "Require exactly one resumed compositor keymap"
        );
        let codes = keyboards[0].keyboard.as_ref().unwrap().shortcut(names)?;
        // No dispatch between keymap validation and emission.
        self.emit_keys(&codes)
    }

    fn emit_keys(&mut self, codes: &[u32]) -> Result<()> {
        ensure!(
            !codes.is_empty() && codes.len() <= 8 && codes.iter().all(|c| (1..=767).contains(c)),
            "Invalid key chord"
        );
        ensure!(
            codes
                .iter()
                .enumerate()
                .all(|(i, c)| !codes[..i].contains(c)),
            "Repeated key in chord"
        );
        let devices: Vec<_> = self
            .devices
            .values()
            .filter(|d| {
                d.resumed
                    && unsafe {
                        ffi::ei_device_has_capability(d.raw.as_ptr(), ffi::EI_DEVICE_CAP_KEYBOARD)
                    }
            })
            .map(|d| d.raw.as_ptr())
            .collect();
        ensure!(
            devices.len() == 1,
            "Require exactly one resumed EIS keyboard"
        );
        let device = devices[0];
        self.emulate(device)?;
        unsafe {
            for code in codes {
                ffi::ei_device_keyboard_key(device, *code, true);
                ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            }
            for code in codes.iter().rev() {
                ffi::ei_device_keyboard_key(device, *code, false);
                ffi::ei_device_frame(device, ffi::ei_now(self.raw.as_ptr()));
            }
            ffi::ei_dispatch(self.raw.as_ptr());
        }
        Ok(())
    }

    pub fn type_text(&mut self, text: &str) -> Result<()> {
        self.dispatch()?;
        let keyboards: Vec<_> = self
            .devices
            .iter()
            .filter(|(_, d)| d.resumed && d.keyboard.is_some())
            .collect();
        ensure!(
            keyboards.len() == 1,
            "Require exactly one resumed compositor keymap"
        );
        let (id, device) = keyboards[0];
        let keyboard = device.keyboard.as_ref().unwrap();
        let plan = keyboard.text(text)?;
        let _identity = *id;
        self.sequence.checked_add(u32::try_from(plan.len())?)
            .context("EIS sequence exhausted; reconnect")?;
        for codes in plan {
            // This bounded plan runs without yielding. Modifier notifications
            // echo our own modifier press/release asynchronously; dispatching
            // an echo halfway through the plan mistakes it for a new held
            // modifier. The complete plan and initial compositor state are
            // validated before emission; every chord releases all its keys.
            self.emit_keys(&codes)?;
        }
        Ok(())
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        self.end_sequence();
        self.devices.clear();
        unsafe {
            ffi::ei_unref(self.raw.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Seek, SeekFrom, Write},
        os::fd::{AsRawFd, FromRawFd},
        time::{Duration, Instant},
    };

    // Real upstream libeis server on an anonymous socket. It has no compositor,
    // desktop seat, portal, or physical-device connection.
    struct Server {
        raw: NonNull<ffi::eis>,
        device: Option<NonNull<ffi::eis_device>>,
        client: Option<NonNull<ffi::eis_client>>,
        moves: Vec<(f64, f64)>,
        buttons: Vec<(u32, bool)>,
        frames: usize,
        duplicate_mapping: bool,
        identical_mapping: bool,
        keys: Vec<(u32, bool)>,
        keymap: Option<std::fs::File>,
        scrolls: Vec<(f64, f64)>,
        scroll_stops: Vec<(bool, bool)>,
    }
    impl Server {
        fn new() -> (Self, Sender) {
            unsafe {
                let raw = NonNull::new(ffi::eis_new(std::ptr::null_mut())).unwrap();
                assert_eq!(ffi::eis_setup_backend_fd(raw.as_ptr()), 0);
                let fd = ffi::eis_backend_fd_add_client(raw.as_ptr());
                assert!(fd >= 0);
                let sender = Sender::new(OwnedFd::from_raw_fd(fd)).unwrap();
                (
                    Self {
                        raw,
                        device: None,
                        client: None,
                        moves: vec![],
                        buttons: vec![],
                        frames: 0,
                        duplicate_mapping: false,
                        identical_mapping: false,
                        keys: vec![],
                        keymap: None,
                        scrolls: vec![],
                        scroll_stops: vec![],
                    },
                    sender,
                )
            }
        }
        fn dispatch(&mut self) {
            unsafe {
                ffi::eis_dispatch(self.raw.as_ptr());
                while let Some(event) = NonNull::new(ffi::eis_get_event(self.raw.as_ptr())) {
                    let ptr = event.as_ptr();
                    match ffi::eis_event_get_type(ptr) {
                        ffi::EIS_EVENT_CLIENT_CONNECT => {
                            let client = ffi::eis_event_get_client(ptr);
                            assert!(ffi::eis_client_is_sender(client));
                            self.client = NonNull::new(ffi::eis_client_ref(client));
                            ffi::eis_client_connect(client);
                            let seat =
                                ffi::eis_client_new_seat(client, c"isolated test seat".as_ptr());
                            ffi::eis_seat_configure_capability(
                                seat,
                                ffi::EIS_DEVICE_CAP_POINTER_ABSOLUTE,
                            );
                            ffi::eis_seat_configure_capability(seat, ffi::EIS_DEVICE_CAP_BUTTON);
                            ffi::eis_seat_configure_capability(seat, ffi::EIS_DEVICE_CAP_KEYBOARD);
                            ffi::eis_seat_configure_capability(seat, ffi::EIS_DEVICE_CAP_SCROLL);
                            ffi::eis_seat_add(seat);
                            ffi::eis_seat_unref(seat);
                        }
                        ffi::EIS_EVENT_SEAT_BIND
                            if ffi::eis_event_seat_has_capability(
                                ptr,
                                ffi::EIS_DEVICE_CAP_POINTER_ABSOLUTE,
                            ) =>
                        {
                            assert!(self.device.is_none());
                            let device = ffi::eis_seat_new_device(ffi::eis_event_get_seat(ptr));
                            ffi::eis_device_configure_type(device, ffi::EIS_DEVICE_TYPE_VIRTUAL);
                            ffi::eis_device_configure_name(
                                device,
                                c"isolated test pointer".as_ptr(),
                            );
                            ffi::eis_device_configure_capability(
                                device,
                                ffi::EIS_DEVICE_CAP_POINTER_ABSOLUTE,
                            );
                            ffi::eis_device_configure_capability(
                                device,
                                ffi::EIS_DEVICE_CAP_BUTTON,
                            );
                            ffi::eis_device_configure_capability(
                                device,
                                ffi::EIS_DEVICE_CAP_KEYBOARD,
                            );
                            ffi::eis_device_configure_capability(
                                device,
                                ffi::EIS_DEVICE_CAP_SCROLL,
                            );
                            let bytes = crate::keyboard::fixture("de");
                            let mut file = tempfile::tempfile().unwrap();
                            file.write_all(&bytes).unwrap();
                            file.seek(SeekFrom::Start(0)).unwrap();
                            let keymap = ffi::eis_device_new_keymap(
                                device,
                                ffi::EIS_KEYMAP_TYPE_XKB,
                                file.as_raw_fd(),
                                bytes.len(),
                            );
                            assert!(!keymap.is_null());
                            ffi::eis_keymap_add(keymap);
                            ffi::eis_keymap_unref(keymap);
                            self.keymap = Some(file);
                            let region = ffi::eis_device_new_region(device);
                            ffi::eis_region_set_size(region, 800, 600);
                            ffi::eis_region_set_offset(region, 100, 200);
                            ffi::eis_region_set_mapping_id(region, c"fixture-monitor".as_ptr());
                            ffi::eis_region_add(region);
                            ffi::eis_region_unref(region);
                            if self.duplicate_mapping {
                                let duplicate = ffi::eis_device_new_region(device);
                                ffi::eis_region_set_size(duplicate, 800, 600);
                                ffi::eis_region_set_offset(
                                    duplicate,
                                    if self.identical_mapping { 100 } else { 900 },
                                    200,
                                );
                                ffi::eis_region_set_mapping_id(
                                    duplicate,
                                    c"fixture-monitor".as_ptr(),
                                );
                                ffi::eis_region_add(duplicate);
                                ffi::eis_region_unref(duplicate);
                            }
                            ffi::eis_device_add(device);
                            ffi::eis_device_resume(device);
                            self.device = NonNull::new(device);
                        }
                        ffi::EIS_EVENT_POINTER_MOTION_ABSOLUTE => self.moves.push((
                            ffi::eis_event_pointer_get_absolute_x(ptr),
                            ffi::eis_event_pointer_get_absolute_y(ptr),
                        )),
                        ffi::EIS_EVENT_FRAME => self.frames += 1,
                        ffi::EIS_EVENT_BUTTON_BUTTON => self.buttons.push((
                            ffi::eis_event_button_get_button(ptr),
                            ffi::eis_event_button_get_is_press(ptr),
                        )),
                        ffi::EIS_EVENT_KEYBOARD_KEY => self.keys.push((
                            ffi::eis_event_keyboard_get_key(ptr),
                            ffi::eis_event_keyboard_get_key_is_press(ptr),
                        )),
                        ffi::EIS_EVENT_SCROLL_DELTA => self.scrolls.push((
                            ffi::eis_event_scroll_get_dx(ptr),
                            ffi::eis_event_scroll_get_dy(ptr),
                        )),
                        ffi::EIS_EVENT_SCROLL_STOP => self.scroll_stops.push((
                            ffi::eis_event_scroll_get_stop_x(ptr),
                            ffi::eis_event_scroll_get_stop_y(ptr),
                        )),
                        _ => {}
                    }
                    ffi::eis_event_unref(ptr);
                }
            }
        }
        fn pump(&mut self, sender: &mut Sender, predicate: impl Fn(&Self, &Sender) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                self.dispatch();
                sender.dispatch().unwrap();
                if predicate(self, sender) {
                    return;
                }
                assert!(Instant::now() < deadline, "libei fixture timed out");
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            unsafe {
                if let Some(device) = self.device {
                    ffi::eis_device_unref(device.as_ptr());
                }
                if let Some(client) = self.client {
                    ffi::eis_client_unref(client.as_ptr());
                }
                ffi::eis_unref(self.raw.as_ptr());
            }
        }
    }

    #[test]
    fn upstream_libeis_receives_only_mapped_bounded_framed_input() {
        let (mut server, mut sender) = Server::new();
        server.pump(&mut sender, |_, sender| sender.ready());
        assert_eq!(
            sender.regions().unwrap(),
            vec![Region {
                mapping_id: Some("fixture-monitor".into()),
                x: 100,
                y: 200,
                width: 800,
                height: 600,
                physical_scale: 1.0,
            }]
        );
        assert!(sender.move_absolute("wrong-monitor", 0.0, 0.0).is_err());
        assert!(sender
            .move_absolute("fixture-monitor", f64::NAN, 0.0)
            .is_err());
        assert!(sender.move_absolute("fixture-monitor", 800.0, 0.0).is_err());
        assert!(sender.move_absolute("fixture-monitor", -1.0, 0.0).is_err());
        server.dispatch();
        assert!(server.moves.is_empty());
        sender.move_absolute("fixture-monitor", 12.5, 34.5).unwrap();
        server.pump(&mut sender, |server, _| server.frames == 1);
        assert_eq!(server.moves, vec![(112.5, 234.5)]);
        assert!(sender.click("fixture-monitor", 1.0, 1.0, 999, 1).is_err());
        sender.click("fixture-monitor", 12.5, 34.5, 272, 2).unwrap();
        server.pump(&mut sender, |server, _| server.buttons.len() == 4);
        assert_eq!(server.frames, 6);
        assert_eq!(
            server.buttons,
            vec![(272, true), (272, false), (272, true), (272, false)]
        );
        assert!(sender.type_text("a😀").is_err());
        server.dispatch();
        assert!(server.keys.is_empty());
        sender.type_text("yY").unwrap();
        server.pump(&mut sender, |server, _| server.keys.len() == 6);
        assert_eq!(
            server.keys,
            vec![
                (44, true),
                (44, false),
                (42, true),
                (44, true),
                (44, false),
                (42, false)
            ]
        );
        sender.end_sequence();
        server.dispatch();
        unsafe {
            ffi::eis_device_pause(server.device.unwrap().as_ptr());
        }
        server.pump(&mut sender, |_, sender| !sender.ready());
        assert!(sender.move_absolute("fixture-monitor", 1.0, 1.0).is_err());
        server.dispatch();
        assert_eq!(server.moves, vec![(112.5, 234.5), (112.5, 234.5)]);
        unsafe {
            ffi::eis_client_disconnect(server.client.unwrap().as_ptr());
        }
        server.dispatch();
        let deadline = Instant::now() + Duration::from_secs(3);
        while sender.dispatch().is_ok() {
            assert!(Instant::now() < deadline, "Disconnect did not reach sender");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!sender.ready());
        assert!(sender.regions().unwrap().is_empty());
    }

    #[test]
    fn duplicate_region_identity_never_selects_the_first_match() {
        let (mut server, mut sender) = Server::new();
        server.duplicate_mapping = true;
        server.pump(&mut sender, |_, sender| sender.ready());
        assert_eq!(sender.regions().unwrap().len(), 2);
        assert!(sender.move_absolute("fixture-monitor", 1.0, 1.0).is_err());
        server.dispatch();
        assert!(server.moves.is_empty());
    }

    #[test]
    fn identical_region_aliases_keep_the_bound_pointer() {
        let (mut server, mut sender) = Server::new();
        server.duplicate_mapping = true;
        server.identical_mapping = true;
        server.pump(&mut sender, |_, sender| sender.ready());
        assert_eq!(sender.regions().unwrap().len(), 1);
        sender.move_absolute("fixture-monitor", 1.0, 2.0).unwrap();
        let selected = sender.pointer_bindings["fixture-monitor"];
        server.pump(&mut sender, |server, _| server.moves.len() == 1);
        assert_eq!(server.moves, vec![(101.0, 202.0)]);
        sender.move_absolute("fixture-monitor", 3.0, 4.0).unwrap();
        assert_eq!(sender.pointer_bindings["fixture-monitor"], selected);
    }

    #[test]
    fn scroll_ends_each_axis_and_shortcuts_release_modifiers() {
        let (mut server, mut sender) = Server::new();
        server.pump(&mut sender, |_, sender| sender.ready());
        assert!(sender
            .scroll("fixture-monitor", 1.0, 1.0, 0.0, f64::INFINITY)
            .is_err());
        assert!(sender
            .scroll("fixture-monitor", 1.0, 1.0, 0.0, 10_001.0)
            .is_err());
        assert!(sender.shortcut(&["Ctrl".into(), "Ctrl".into()]).is_err());
        server.dispatch();
        assert!(server.moves.is_empty() && server.keys.is_empty());
        sender
            .scroll("fixture-monitor", 1.0, 2.0, 0.0, -120.0)
            .unwrap();
        sender.shortcut(&["Ctrl".into(), "s".into()]).unwrap();
        server.pump(&mut sender, |server, _| server.frames == 7);
        assert_eq!(server.moves, vec![(101.0, 202.0)]);
        assert_eq!(server.scrolls, vec![(0.0, -120.0)]);
        assert_eq!(server.scroll_stops, vec![(false, true)]);
        assert_eq!(
            server.keys,
            vec![(29, true), (31, true), (31, false), (29, false)]
        );
    }

    #[tokio::test]
    async fn cancelled_drag_releases_its_held_button() {
        let (mut server, mut sender) = Server::new();
        server.pump(&mut sender, |_, sender| sender.ready());
        let path = [(1.0, 2.0), (10.0, 20.0), (30.0, 40.0)];
        let mut drag = Box::pin(sender.drag("fixture-monitor", &path));
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            tokio::select! {
                _ = &mut drag => panic!("Drag ended before the cancellation point"),
                _ = tokio::time::sleep(Duration::from_millis(1)) => server.dispatch(),
            }
            if server.buttons == vec![(272, true)] { break; }
            assert!(Instant::now() < deadline);
        }
        drop(drag);
        server.pump(&mut sender, |server, _| server.buttons.len() == 2);
        assert_eq!(server.buttons, vec![(272, true), (272, false)]);
    }
}
