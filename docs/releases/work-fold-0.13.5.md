# work-fold 0.13.5

November 2, 2026

Connect Microsoft Foundry chat deployments through Settings → AI Models.

- **OpenAI and Anthropic endpoints.** Foundry connections support Pi's native OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages adapters. OpenAI and Anthropic connections can stay connected together, each with its own endpoint, API key, and deployment names.
- **Custom deployment names.** Optional Deployment model details selects a base model from Pi's catalog so a renamed deployment uses the appropriate context, image, and reasoning capabilities. Unknown aliases in new connections start with Pi's generic limits. Native Pi model definitions and overrides stay available. If saved metadata needs correction, Settings stays usable to repair or remove that connection.
- **Existing Azure connections.** Saved Azure deployments retain Pi's per-model API choice. Endpoint and deployment edits preserve the stored key or environment-key reference, and first connections can use an environment-supplied key.
- **Connection details stay separate.** Switching providers preserves unsaved endpoints and deployment names while clearing entered keys. Saving a connection keeps the Worker's model selection separate.
- **Settled shutdown.** Shutdown waits for startup Recently deleted cleanup to finish writing its state.

This connection setup uses API keys for chat deployments. Saving settings does
not create deployments or make a paid inference request.

Mac releases and automatic updates are available through the
[work-fold Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases).
