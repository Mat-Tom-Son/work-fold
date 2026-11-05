# work-fold 0.14.0

November 5, 2026

This release gives moves and deletes of several Files rows one restore point, and tidies the composer and the work-folder header.

- Moving or deleting several rows in Files saves one History restore point for all of them, so one restore undoes the whole action. Each deleted row still gets its own receipt, and anything History cannot keep goes to Recently Deleted.
- If one row fails partway, the rows already done keep a restore point and the rest are left alone.
- Right-clicking the work-folder header opens the native Mac menu, like tabs and Files.
- In the composer, Commands and the model chip are the same size as the buttons beside them and share one rounded hover.

Mac releases and automatic updates are available through the
[work-fold Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases).
