# Connected inbox full-trust Pi Extension example

This demonstrates the native Pi compatibility lane: `package.json` declares a full-trust Extension, `index.ts` owns executable or network behavior, and the adjacent `surface.json` contributes host-rendered navigation and views.

The sample tool accepts HTTPS JSON endpoints, caps responses at 128 KB, and returns the result to the Assistant. It deliberately does not store credentials or claim a real email connection. Binding live tool data, connection state, refresh, and permissioned actions into the surface is the next host-bridge contract.

Install this directory through the normal local-package flow in **Assistant tools** only when its source is trusted. Package scope determines whether it is Personal or belongs to This Space; a project-scoped package loads while its folder is registered as a Space.

The manifest is not a sandbox for the Extension. Extension code runs with the current user's permissions and must disclose its endpoints, credentials, and side effects during package review.

Do not use this format as the default for agent-generated apps. The [restricted connected inbox app](../restricted-connected-inbox/README.md) uses the separate reviewed-web package shape that work-fold can inspect and stage without evaluating JavaScript. Use the canonical [Restricted app authoring guide](../../../docs/restricted-app-authoring.md) for that package and bridge contract, and [Restricted app runtime](../../../docs/restricted-app-runtime.md) for its security architecture.
