# Image generation

Workers and the work-fold agent can make pictures with a connected image model:
banners, illustrations, backgrounds, and anything else a person asks for. In a
Worker Chat the picture shows under the reply, and it becomes a file in the
folder only when the person adds it or asked the Worker to save it there.

## The tool

Every session has a native `generate_image` tool
(`src/local/agent/image-generation-tool.ts`). It takes:

- `prompt`: what the picture shows (subject, style, mood, colors);
- `path`: optional; where to save it, relative to the session's folder, when the
  person asked for a file there;
- `shape`: `wide` (about 21:9, for a work-folder banner), `square`, or `tall`;
- `model`: an optional `{ provider, id }` naming one connected image model.

A path must stay inside the folder and outside `.work-fold`, `.pi`, `.git`,
and `.workspace`. The model decides the format, and the file extension follows
it (asking for `banner.png` and receiving a JPEG saves `banner.jpg`). Without a
path the picture stays out of the folder; the older `temporary: true` option
means the same. The result gives the picture's absolute file path (for example,
to apply it as a banner), its dimensions, the model, and the cost when the
provider reports one. When the session's own model can see images, a small copy
comes back too, so the Worker can check its work.

## In the Chat

Every picture a Worker makes is kept in work-fold's own app state
(`generated-images/` under the state root, `src/local/agent/generated-image-store.ts`),
outside every work-folder, under a random id. The Chat log records only that id
with the picture's name, type, and size on the finished `generate_image` step,
never the bytes, so a Chat that travels with its folder shows "not on this
computer" elsewhere instead of a broken image. A picture the Worker saved in the
folder still loads from there.

The pictures show under the Worker's reply whatever the Worker-steps setting
is. Hovering one offers:

- **Copy**, which puts the picture alone on the clipboard as PNG, so pasting
  gives the picture rather than its name;
- **Add to folder**, which writes it at the top of the work-folder under its
  name (beside, never over, an existing file of that name) with the same
  restore point as an upload;
- **Show in Files**, in place of Add to folder, once the picture is in the
  folder. It counts only while the file there is still this picture, compared by
  content, so a different file that took its name is never shown in its place.

The routes are `GET /api/generated-images/:id` (the bytes) and
`GET`/`POST /api/work-folders/:workFolderId/generated-images/:id[/add]`.
The work-fold agent's panel does not show pictures yet, so its tool keeps them
in temporary space and does not say they appear in the Chat.

## Models and providers

The tool calls Pi's image API (`ModelRuntime.generateImages`), the same model
registry and credentials as chat. Today Pi generates images through
OpenRouter, whose catalog lists dozens of image models (Google's Nano Banana
line, OpenAI's GPT Image, FLUX, Recraft, Seedream, and more). Any provider that
registers an image API with Pi and lists image models works the same way.

Pi lists no image models for OpenAI or Google yet, so work-fold reaches them
directly (`src/local/agent/direct-image-models.ts`). It uses the API key Pi
already holds for that provider (`ModelRuntime.getAuth`) and the same base URL
as the provider's chat models, and never changes the provider's chat models.
These models are listed only for a connected provider:

- **OpenAI** (Images API, `POST /images/generations`): `gpt-image-2`,
  `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-1-mini`, and
  `gpt-image-1`. A wide picture is 2048×864 (1536×1024 for GPT Image 1 models,
  which take only fixed sizes).
- **Google** (Gemini Interactions API, `POST /interactions`):
  `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`,
  `gemini-nano-banana-2.1`, and `gemini-2.5-flash-image`. Wide is 16:9, which
  every Nano Banana model accepts.

When Pi lists image models for a provider, work-fold uses Pi's and drops its own
for that provider. A ChatGPT account sign-in (`openai-codex`) is a different
provider and has no image models here.

**Choosing the model.** Settings → AI Models → **Image model** holds one
machine-wide choice for every Worker and the work-fold agent, saved as soon as
it is picked (`image-model.json` in work-fold's app state, never in a
work-folder). Its first entry, **Automatic**, shows the model Automatic would
use right now. A chosen model whose provider is later disconnected falls back
to Automatic until it is connected again, and the section says so. A model the
Worker names for one picture still wins.

With no model named or chosen, work-fold uses the first connected model from a short
preference list: Gemini 3.1 Flash Image, GPT Image 2, Gemini 2.5 Flash Image,
GPT Image 1 Mini, then FLUX.2 Pro, matched with or without a vendor prefix so a
provider's own copy of a model counts too. It never picks a router such as
`openrouter/auto`, and when no image model is connected it says so and points
to Settings → AI Models. OpenRouter receives the shape as its
`image_config.aspect_ratio` option.

## Making a picture the work-folder's banner

`work-fold work-folders appearance apply --work-folder <id> --banner-image <path>`
turns an image file into the work-folder's banner. `--icon <name>` and
`--color <#rrggbb>` change those parts the same way. Each named part replaces
only itself, and the rest of the appearance stays. The image is read
host-side, resized to fit 1600×640, and stored as the same bounded data URL the
Customize dialog keeps for an upload. It is a receipted act with one-step
`appearance undo`. See [work-folder customization](work-folder-customization.md).

## Privacy

The prompt goes to the image model's provider under that provider's terms, like
any other model request. Pictures shown in a Chat stay in work-fold's
machine-local app state; only those the person adds, or asked the Worker to
save, become files in the work-folder.
