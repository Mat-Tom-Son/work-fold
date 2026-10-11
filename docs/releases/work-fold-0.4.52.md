# work-fold 0.4.52

October 11, 2026

- Closing the work-fold agent panel no longer breaks the window layout. In 0.4.51, closing the panel after opening it squeezed the work area to half height.
- The work-fold agent's chat stays on its newest message. This holds while the agent works, when you open the panel, and when you come back from Chats. A **Latest** button appears while you read older messages. The reasoning level now sits right against its arrow.
- Apps live in their left pane. An app's rail button shows its view there and never opens a tab by itself. A tab opens only when you click something in that view, the same way a file in Files opens its preview. Extensions also show their views in the left pane, and clicking one opens it.
- Apps look like work-fold. They follow the shell's colors, font, and corners, light and dark mode, and the work-folder's accent. An app can put the same green "new" dot the Chats use on its rail button. Workers now start new apps from a working template.
- Chats an app starts say "From {app}" and carry the app's name in their title. Steps where a Worker uses an app's tools name the app. Automation errors keep their full text, folded in Settings → Apps.
- Settings → Apps has an **App Studio** button for each work-folder and a **Share at your address** button for apps that have a browser view. Deleting a Release in App Studio moves it to Recently deleted. Larger app data backups can be restored.
- Apps are more tightly contained:
  - An automation uses only the permissions it declares, even when it shares a running background process with the app's tools.
  - Files dragged or pasted in from your computer don't reach an app.
  - What an app hands a Worker is marked as untrusted input.
- In your browser on work-fold.com, the **Files and apps** links under a chat work again. App views show the real work-folder name, and anything too large to send to the browser shows a clear message.

For app authors: `tabs.open` now works only from the app's left-pane view, in response to the person's click or key press. A tab cannot open other tabs; it moves within itself with `tabs.update`. Anything else is refused with `TAB_DENIED`. See [Restricted app authoring](../restricted-app-authoring.md) for the theme variables, the `/__work-fold/kit.css` kit, and `attention.set`.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
