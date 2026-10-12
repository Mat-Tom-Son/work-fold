# work-fold 0.10.0

October 11, 2026

This release makes work-fold easier to start with and lets Workers make pictures.

- First run is three short steps: what work-fold is, **Connect your AI**, then your first folder. Connect your AI puts ChatGPT, Claude, and OpenRouter first and finds any other provider with a search. When the app includes them, an optional step sets up Chrome and Computer Control too.
- Nothing dead-ends without AI. The composer shows **Connect AI** where the model would be, a reply that stopped for want of a model has a **Connect AI** button, and **Set up for me** connects first and then carries on. Connecting a provider also picks a good model to start with.
- **Set up for me** looks over a new work-folder, organizes it, writes instructions for its Worker, and gives it a banner, icon, and color. **Just the look** does only the banner, icon, and color. Both are offered after you add a work-folder and in the work-folder menu.
- Workers can make pictures with a connected image model, including OpenRouter's, OpenAI's, and Google's. Pictures show in the Chat; hover one to **Copy** it or **Add to folder**. Choose the image model in Settings → AI Models.
- Computer Control setup is one **Allow** button that waits for your OK in System Settings and names what to turn on: **work-fold Computer**.
- Chrome setup shows two steps, add the extension and choose Connect in it, and works in either order.
- The file you last clicked in Files is no longer sent to the Worker, so a file deleted since can't stop a message.
- Changing a work-folder's Worker instructions while it is working applies to its next turn instead of being refused.

For agents on the CLI: `work-fold work-folders appearance apply --banner-image <file> --icon <name> --color <#rrggbb>` changes just those parts, with `appearance undo`. See [Image generation](../image-generation.md).

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
