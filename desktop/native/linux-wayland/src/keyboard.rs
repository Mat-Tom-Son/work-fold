//! Translate against the compositor's keymap with libxkbcommon. No hardcoded
//! layout tables, clipboard injection, or assumptions about a US keyboard.
use anyhow::{ensure, Context, Result};
use xkbcommon::xkb;

pub struct Keyboard {
    keymap: xkb::Keymap,
    pub modifiers: [u32; 4], // depressed, latched, locked, group from libei
}

impl Keyboard {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(
            !bytes.is_empty() && bytes.len() <= 1024 * 1024,
            "Invalid keymap size"
        );
        // libei supplies a byte length, unlike Wayland's NUL-terminated keymap
        // convention. Mutter sends XKB text without a trailing NUL. Accept one
        // optional terminator and still reject interior NULs before libxkbcommon.
        let text = std::str::from_utf8(bytes.strip_suffix(&[0]).unwrap_or(bytes))?;
        ensure!(!text.contains('\0'), "Embedded keymap terminator");
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_string(
            &context,
            text.to_owned(),
            xkb::KEYMAP_FORMAT_TEXT_V1,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .context("Compositor keymap could not be compiled")?;
        ensure!(
            keymap.min_keycode().raw() >= 8 && keymap.max_keycode().raw() <= 775,
            "Keymap is outside EVDEV bounds"
        );
        Ok(Self {
            keymap,
            modifiers: [0; 4],
        })
    }

    fn idle(&self) -> Result<()> {
        ensure!(
            self.modifiers[0] == 0 && self.modifiers[1] == 0,
            "Release held or latched keyboard modifiers before typing"
        );
        ensure!(
            self.modifiers[3] < self.keymap.num_layouts(),
            "Keyboard layout is unavailable"
        );
        Ok(())
    }

    fn unshifted_symbol(&self, symbol: xkb::Keysym) -> Option<u32> {
        (self.keymap.min_keycode().raw()..=self.keymap.max_keycode().raw())
            .find(|code| {
                self.keymap
                    .key_get_syms_by_level(xkb::Keycode::new(*code), self.modifiers[3], 0)
                    == [symbol]
            })
            .map(|code| code - 8)
    }

    /// Preflight every character before returning any events. XKB determines
    /// the actual Shift/level-three/level-five state; no layout table or fixed
    /// modifier mask is assumed. Compose and IME-only text fails explicitly.
    pub fn text(&self, text: &str) -> Result<Vec<Vec<u32>>> {
        self.idle()?;
        ensure!(
            !text.is_empty() && text.chars().count() <= 256,
            "Type at most 256 characters per action"
        );
        let mut modifiers = Vec::new();
        for alternatives in [
            &["Shift_L", "Shift_R"][..],
            &["ISO_Level3_Shift"],
            &["ISO_Level5_Shift"],
        ] {
            if let Some(code) = alternatives.iter().find_map(|name| {
                self.unshifted_symbol(xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS))
            }) {
                if !modifiers.contains(&code) {
                    modifiers.push(code);
                }
            }
        }
        // Prefer fewer modifiers, preserving plain and Shift typing. In
        // particular, never synthesize Ctrl+Alt as an assumed AltGr substitute.
        let mut combinations: Vec<usize> = (0..1 << modifiers.len()).collect();
        combinations.sort_by_key(|mask| mask.count_ones());
        let states: Vec<_> = combinations
            .into_iter()
            .map(|mask| {
                let mut state = xkb::State::new(&self.keymap);
                state.update_mask(0, 0, self.modifiers[2], 0, 0, self.modifiers[3]);
                let held: Vec<_> = modifiers
                    .iter()
                    .enumerate()
                    .filter_map(|(index, code)| (mask & (1 << index) != 0).then_some(*code))
                    .collect();
                for code in &held {
                    state.update_key(xkb::Keycode::new(code + 8), xkb::KeyDirection::Down);
                }
                (held, state)
            })
            .collect();
        let mut plan = Vec::new();
        for character in text.chars() {
            let mut found = None;
            for (held, state) in &states {
                for code in self.keymap.min_keycode().raw()..=self.keymap.max_keycode().raw() {
                    if state.key_get_utf8(xkb::Keycode::new(code)) == character.to_string() {
                        let mut chord = held.clone();
                        chord.push(code - 8);
                        found = Some(chord);
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            plan.push(found.context("Text requires an unavailable layout, compose sequence, IME or modifier layer; use semantic text entry")?);
        }
        Ok(plan)
    }

    pub fn shortcut(&self, names: &[String]) -> Result<Vec<u32>> {
        self.idle()?;
        ensure!(
            !names.is_empty() && names.len() <= 8,
            "Invalid shortcut length"
        );
        let mut codes = Vec::new();
        for name in names {
            ensure!(name.len() <= 64 && !name.contains('\0'), "Invalid key name");
            let alias = match name.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => "Control_L",
                "alt" => "Alt_L",
                "shift" => "Shift_L",
                "super" | "meta" | "win" => "Super_L",
                "enter" => "Return",
                "esc" => "Escape",
                "backspace" => "BackSpace",
                "space" => "space",
                _ => name.as_str(),
            };
            let symbol = xkb::keysym_from_name(alias, xkb::KEYSYM_CASE_INSENSITIVE);
            let code = self
                .unshifted_symbol(symbol)
                .context("Shortcut key is absent from the compositor keymap")?;
            ensure!(!codes.contains(&code), "Repeated shortcut key");
            codes.push(code);
        }
        Ok(codes)
    }
}

#[cfg(test)]
pub fn fixture(layout: &str) -> Vec<u8> {
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    let keymap = xkb::Keymap::new_from_names(
        &context,
        "",
        "",
        layout,
        "",
        None,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .unwrap();
    let mut bytes = keymap
        .get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1)
        .into_bytes();
    bytes.push(0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    fn typed_text(keyboard: &Keyboard, chords: &[Vec<u32>]) -> String {
        let mut state = xkb::State::new(&keyboard.keymap);
        state.update_mask(0, 0, keyboard.modifiers[2], 0, 0, keyboard.modifiers[3]);
        let mut text = String::new();
        for chord in chords {
            for code in &chord[..chord.len() - 1] {
                state.update_key(xkb::Keycode::new(code + 8), xkb::KeyDirection::Down);
            }
            text.push_str(&state.key_get_utf8(xkb::Keycode::new(chord[chord.len() - 1] + 8)));
            for code in chord[..chord.len() - 1].iter().rev() {
                state.update_key(xkb::Keycode::new(code + 8), xkb::KeyDirection::Up);
            }
        }
        text
    }

    #[test]
    fn german_level_three_text_preserves_symbols_and_locked_state() {
        let mut keyboard = Keyboard::parse(&fixture("de")).unwrap();
        let text = "Grüße: mail@example.de € {value} [x] \\ | ~";
        assert_eq!(typed_text(&keyboard, &keyboard.text(text).unwrap()), text);
        let caps = keyboard.keymap.mod_get_index("Lock");
        assert!(caps < 32);
        keyboard.modifiers[2] = 1 << caps;
        let locked_text = "Äpfel: MAIL@example.de € {value} [x] \\ | ~";
        assert_eq!(
            typed_text(&keyboard, &keyboard.text(locked_text).unwrap()),
            locked_text
        );
        assert_eq!(keyboard.modifiers, [0, 0, 1 << caps, 0]);
        assert!(keyboard.text("mail@example.de 😀").is_err());
    }

    #[test]
    fn compositor_layout_controls_typing_and_shortcuts() {
        let us = Keyboard::parse(&fixture("us")).unwrap();
        let mut unterminated = fixture("us");
        unterminated.pop();
        assert_eq!(
            Keyboard::parse(&unterminated).unwrap().text("a").unwrap(),
            us.text("a").unwrap()
        );
        assert!(Keyboard::parse(b"xkb\0keymap").is_err());
        let de = Keyboard::parse(&fixture("de")).unwrap();
        assert_eq!(
            us.text("yzY").unwrap(),
            vec![vec![21], vec![44], vec![42, 21]]
        );
        assert_eq!(
            de.text("yzY").unwrap(),
            vec![vec![44], vec![21], vec![42, 44]]
        );
        assert_eq!(
            us.shortcut(&["Ctrl".into(), "s".into()]).unwrap(),
            vec![29, 31]
        );
        assert!(
            us.text("a😀").is_err(),
            "Unsupported text fails before emitting the supported prefix"
        );
        let mut held = us;
        held.modifiers[0] = 1;
        assert!(held.text("a").is_err());
        assert!(Keyboard::parse(b"bad").is_err());
    }
}
