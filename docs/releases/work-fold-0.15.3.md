# work-fold 0.15.3

November 6, 2026

This release improves Computer Control on Mac and fixes interactive terminal
compatibility.

- Computer Control keeps the original control it observed and checks that it
  still belongs to the same target. A changed control requires a fresh look;
  the Worker does not substitute a nearby, similar control.
- Native text areas remain usable when an app omits optional accessibility
  attributes; the fields the app did expose continue to be checked.
- A command whose effect is uncertain stops without an automatic duplicate
  click. Text entry gets a short settle window, and a readable field that
  still lacks its text stops the remaining actions in that batch.
- Waiting for something to appear or disappear handles number-valued controls,
  such as scroll bars and checkboxes, and reports when an incomplete window
  read prevents confirmation.
- Text results preserve the app's own formatting and keep a failed or
  unverified postcondition separate from a successful text write.
- Interactive terminals preserve Unicode input and output with both Tcl 8
  and Tcl 9, including output split across multibyte characters.

Mac releases and automatic updates are available through the
[work-fold Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases).
