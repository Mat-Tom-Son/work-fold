# work-fold 0.4.39

September 30, 2026

This update makes Files and Chat easier to use and improves automatic Chat
naming with Azure OpenAI.

- Create a folder inside the current Folder from the Files toolbar, or choose
  **New Folder Here** on a directory to create one inside it. A naming dialog
  handles duplicate names, and History records a restore point.
- Attach a file to Chat with a quiet file icon, filename, and remove control.
  The Worker receives the original file path and uses its tools to inspect
  documents when needed. Supported images keep their native vision support.
- Generate Chat titles with the Chat's selected model and connection,
  including Azure deployments. Reasoning models use a supported ordinary
  effort level; incomplete title responses are not saved.
- Keep the message copy button at the left of its row, with the timestamp
  appearing immediately to its right on hover or keyboard focus.

Downloads: [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest).
