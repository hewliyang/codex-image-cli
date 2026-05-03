# @hewliyang/codex-image-cli

Standalone Node.js CLI/SDK for generating or editing images through the ChatGPT Codex subscription via the Responses API

```json
tool_choice: { type: "image_generation" }
```

## Install


```bash
npm install -g @hewliyang/codex-image-cli
img-gen --help
```

## Usage

```bash
img-gen -o out.png -s 1024x1024 "draw a tiny red dragon sticker"
img-gen -i out.png -o edited.png "edit this into a blue dragon"
img-gen check
```

For local development:

```bash
npm install
npm run build
node dist/index.js -o out.png -s 1024x1024 "draw a tiny red dragon sticker"
```

## Auth

Login to Codex with Pi or Codex, the CLI consumes their access tokens. Token refresh is not supported by calls via the CLI.

## SDK

```ts
import { generateImage } from "@hewliyang/codex-image-cli";

const result = await generateImage({
  prompt: "draw a tiny red dragon sticker",
  outputPath: "out.png",
  size: "1024x1024",
});
```

## Agent skill

This package includes an agent skill adapted from Codex's image generation guidance for the `img-gen` CLI:

```text
skills/img-gen/SKILL.md
```

Use it when an agent should generate/edit raster images via the installed CLI instead of a built-in image tool.

The skill also bundles:

```text
skills/img-gen/references/prompting.md
skills/img-gen/references/sample-prompts.md
skills/img-gen/scripts/remove_chroma_key.py
```

for prompt guidance, copy/paste recipes, and chroma-key-to-alpha post-processing when native transparent output is not good enough.
