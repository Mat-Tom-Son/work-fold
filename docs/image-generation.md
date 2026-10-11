# Image generation

Workers and the work-fold agent can make pictures with a connected image model:
banners, illustrations, backgrounds, and anything else a person asks for. The
picture is saved as an ordinary file in the folder the session works in, so it
is visible in Files, captured by History, and removable like any other file.

## The tool

Every session has a native `generate_image` tool
(`src/local/agent/image-generation-tool.ts`). It takes:

- `prompt`: what the picture shows (subject, style, mood, colors);
- `path`: where to save it, relative to the session's folder;
- `shape`: `wide` (about 21:9, for a work-folder banner), `square`, or `tall`;
- `model`: an optional `{ provider, id }` naming one connected image model.

The path must stay inside the folder and outside `.work-fold`, `.pi`, `.git`,
and `.workspace`. The model decides the format, and the file extension follows
it (asking for `banner.png` and receiving a JPEG saves `banner.jpg`). The
result reports the path, dimensions, model, and cost when the provider reports
one. When the session's own model can see images, a small copy comes back too,
so the Worker can check its work.

## Models and providers

The tool calls Pi's image API (`ModelRuntime.generateImages`), the same model
registry and credentials as chat. Today Pi generates images through
OpenRouter, whose catalog lists dozens of image models (Google's Nano Banana
line, OpenAI's GPT Image, FLUX, Recraft, Seedream, and more). Any provider that
registers an image API with Pi and lists image models works the same way.

With no model named, work-fold uses the first connected model from a short
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
any other model request. Generated files stay in the work-folder.
