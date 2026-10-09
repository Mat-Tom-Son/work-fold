# work-fold 0.4.50

October 9, 2026

- ChatGPT account sign-in now supplies and saves Pi's installation device ID, fixing the missing UUID error when connecting an account.
- AI Models separates provider connections from model selection. Saved connections remain available when switching providers, and the searchable model picker groups models from every connected provider.
- Provider setup follows Pi's native API-key and account sign-in methods, including guided setup and provider-specific configuration. Complete credentials are kept in the machine's encrypted credential store.
- Azure OpenAI saves its endpoint, API key, and deployment names independently of the selected model. Connecting or changing a provider preserves the Worker or work-fold agent's saved model.
- Settings has consistent spacing and aligned controls. Save Instructions sits below its text field, and narrow windows keep a compact navigation row.

The [Mac release feed](https://github.com/Mat-Tom-Son/work-fold-mac-releases/releases/latest) records publication; source notes alone do not establish availability.
