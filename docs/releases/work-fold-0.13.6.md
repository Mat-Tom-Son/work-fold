# work-fold 0.13.6

November 3, 2026

Follow context usage during work and inspect the OpenAI account connected to work-fold.

- **Live context usage.** The composer's context circle updates as the Worker streams its response and finishes tool steps. The usage tooltip remains readable during a turn, and reconnects and Stop refresh the current context without restoring stale counts.
- **Visible compaction.** Successful manual, automatic, and background compactions leave a saved Chat notice explaining that earlier messages were summarized and the chat history remains available. Notices stay with their own Chat. Cancelled or failed summaries do not claim success.
- **OpenAI account details.** Settings → AI Models can read the connected account's email and display workspace and plan details when OpenAI provides them. Refreshing details preserves model choices and unsaved instructions, and connection changes discard stale account data.
- **Usage management.** OpenAI's current direct sign-in integration does not provide plan quotas or reset times. Manage usage in ChatGPT opens the provider's usage settings; work-fold does not infer subscription limits from local token counts.

Mac releases and automatic updates are available through the
[work-fold Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases).
