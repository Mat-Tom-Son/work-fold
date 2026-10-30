# work-fold 0.13.1

October 27, 2026

Workers now pick up more gracefully after interruptions, stalls, and long Chats.

- **Continue after an interruption.** When work-fold closes or crashes mid-reply, the Chat's last reply offers **Continue**, which sends "Continue where you left off." as an ordinary message. Nothing runs again on its own. Quitting mid-reply now says the app closed instead of "Response stopped". A tool cut off mid-run reaches the Worker as possibly partly done, so it checks before running it again.
- **Resend a reply that goes silent.** A reply that sends nothing for three minutes is sent again automatically, keeping what had arrived. A reply that is still producing is never cut off.
- **Summarize long Chats in the background.** A Chat nearing its context limit is summarized while it is idle, so the next message does not wait on it. Any new message, copy, deletion, or quit cancels that summary.
- **Queue and steer from every window.** A message queued with ⌘Enter is held by work-fold, so every window shows it and it outlives the window that queued it. It goes when the current work ends, with its files and @Worker mentions, and never after a Stop; a stopped one waits, marked not sent. Press Enter to steer the work-fold agent from the menu-bar panel and the agent panel.

A queued message lives in the running app; quitting work-fold drops it. Steering
from a paired browser arrives with the next web update.

See [Product model](../product-model.md) and [the work-fold agent and CLI](../work-fold-agent-and-cli.md).
The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest)
records publication; source notes alone do not establish availability.
