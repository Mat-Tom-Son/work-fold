# work-fold 0.9.0

October 11, 2026

work-fold skips ahead to 0.9 on the way to 1.0. This release is about Automations.

- Automations have a place in each work-folder. When an automation touches the work-folder, the **Automations** rail button lists it in the left pane. Click one to open it in a tab with its trigger, its last run, and **Run now**, **Turn on**, and **Turn off**. Settings → Automations is still where you manage all of them.
- Folder automations can catch up. If files land in a watched folder while work-fold is closed or the computer is asleep, the automation can start one run for them when work-fold is back, and that run lists the files. Ask the work-fold agent for this when it sets up a folder automation.
- Each automation step can use its own model. For example, a step that looks at screenshots can use a model that sees images, and your work-folder and work-fold agent keep their own models. work-fold checks the model when you turn the automation on. `work-fold automations models` lists your connected models and which ones see images.
- An automation's Chat knows it's running on its own. The Worker does the work instead of asking for help, then reports what it did, and the run history shows that report. If the Worker couldn't do it, the step fails in its own words. If it finished only part, the run says **Partly done**.
- A folder automation now notices a file you drop in right after turning it on. Before, that first file could be missed.
- Removing a work-folder keeps its App Studio history in Recently deleted. Register the folder again to restore it.
- Clicking an app's notification opens the app's left pane at the place the notification points to. Settings → Apps lists each app's recent notifications.
- Quitting work-fold no longer waits for a Chat reply that hadn't started yet.

For app authors: `notifications.show` takes an optional `route` and `state`, and a click sets `context.openedFrom` to the notification. See [Restricted app authoring](../restricted-app-authoring.md).

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
