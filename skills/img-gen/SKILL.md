---
name: "img-gen"
description: "Use the img-gen CLI from @hewliyang/codex-image-cli to generate or edit raster images via the user's ChatGPT Codex OAuth token. Trigger for photos, illustrations, textures, sprites, mockups, hero images, product shots, visual variants, image edits, or transparent-background bitmap assets. Do not use when editing SVG/vector/code-native assets is more appropriate."
---

# img-gen skill

Use the `img-gen` CLI to create or edit PNG images through Codex `image_generation`. It uses the user's Codex/Pi OAuth token, not an OpenAI Platform API key.

## Quick commands

Check auth:

```bash
img-gen check --json
```

Generate:

```bash
img-gen -o assets/hero.png -s 1536x1024 -q high "<prompt>"
```

Edit or condition on local images:

```bash
img-gen -i input.png -o output.png "<edit prompt>"
```

Use multiple inputs by repeating `-i`:

```bash
img-gen -i target.png -i style-ref.png -o output.png "Image 1 is the edit target. Image 2 is the style reference. <prompt>"
```

Machine-readable output:

```bash
img-gen --json -o output.png "<prompt>"
```

## CLI contract

Options:

- `-p, --prompt <text>`: prompt. If omitted, remaining args are joined.
- `-i, --input <path>`: input/reference/edit image. Repeatable.
- `-o, --output <path>`: output PNG path.
- `-s, --size <WxH|auto>`: size. Popular values: `1024x1024`, `1536x1024`, `1024x1536`, `2048x1152`, `3840x2160`, `2160x3840`, `auto`.
- `-q, --quality <auto|low|medium|high>`.
- `-b, --background <auto|transparent|opaque>`.
- `--json`: print JSON summary.
- `--verbose`: progress to stderr.

Size constraints for explicit `WIDTHxHEIGHT`:

- each edge <= `3840`
- both edges multiples of `16`
- aspect ratio <= `3:1`
- total pixels between `655,360` and `8,294,400`

Default output path, when `--output` is omitted: `~/.codex-image/images/<timestamp>-<prompt-slug>.png`.

## When to use

Use for raster outputs:

- New images: concept art, product shots, website heroes, cover art, sprites, textures, UI mockups, infographics.
- Reference-based generation: style, composition, mood, or subject references.
- Image edits: background replacement, object removal/replacement, compositing, lighting/weather changes, restyling, transparent cutouts.
- Multiple assets/variants: run one `img-gen` command per distinct asset or variant.

## When not to use

Do not use `img-gen` when:

- The repo already has editable SVG/vector/source assets that should be modified directly.
- The user wants a deterministic simple diagram, CSS gradient, icon, or layout better produced in SVG/HTML/CSS/canvas.
- The request is to extend an existing logo/icon system and matching the source style is more important than generating a bitmap.

## Workflow

1. Decide whether the request is generation or editing.
2. Decide whether the output is preview-only or project-bound.
3. Pick an output path up front for project-bound assets. Never leave a project-referenced asset only in the default output directory.
4. For each input image, label its role in the prompt: edit target, style reference, composition reference, insert subject, etc.
5. Use `--json` when automation needs the saved path.
6. Inspect the result before using it in code or reporting completion.
7. Iterate with one targeted change at a time, restating invariants.
8. Do not overwrite existing project assets unless asked; use sibling names like `hero-v2.png` or `item-icon-edited.png`.
9. Report final saved path(s), prompt(s), and notable options used.

## Prompting guidance

Order prompts as: scene/backdrop -> subject -> key details -> constraints -> output intent.

For complex requests, use short labeled lines:

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: Image 1: <role>; Image 2: <role>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Specificity policy:

- If the user prompt is specific, preserve it and only normalize/structure it.
- If the prompt is generic, add tasteful detail only when it materially improves the output.
- Do not add extra characters, props, brands, palettes, slogans, or story beats not implied by the request.
- For edits, explicitly say what must remain unchanged.

For in-image text:

- Quote exact text.
- Specify typography and placement.
- For important/unusual words, spell them letter by letter.
- Ask for verbatim rendering and no extra text.

For photorealism:

- Say `photorealistic`.
- Include concrete real-world texture and imperfect detail: material grain, fabric wear, natural lighting, lens/framing language.

## Transparent background

Try native transparency first:

```bash
img-gen -b transparent -o cutout.png "<subject>, isolated, transparent background, no shadow, no text, no watermark"
```

If transparency is ignored or edges are poor, rerun with a flat chroma-key background and remove it locally with whatever image tooling is available in the environment:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

Use magenta `#ff00ff` instead of green if the subject is green.

## Use-case taxonomy

Generate:

- `photorealistic-natural`
- `product-mockup`
- `ui-mockup`
- `infographic-diagram`
- `scientific-educational`
- `ads-marketing`
- `productivity-visual`
- `logo-brand`
- `illustration-story`
- `stylized-concept`
- `historical-scene`

Edit:

- `text-localization`
- `identity-preserve`
- `precise-object-edit`
- `lighting-weather`
- `background-extraction`
- `style-transfer`
- `compositing`
- `sketch-to-render`

## Examples

Website hero:

```bash
img-gen -o assets/hero-mug.png -s 1536x1024 -q high \
  'Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: wide composition with usable negative space for page copy
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark'
```

Targeted edit:

```bash
img-gen -i product.png -o product-sunset.png -q high \
  'Use case: precise-object-edit
Asset type: product photo background replacement
Input images: Image 1 is the edit target.
Primary request: replace only the background with a warm sunset gradient
Constraints: keep the product, product edges, perspective, and proportions unchanged; no text; no watermark'
```
