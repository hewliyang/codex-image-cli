#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.5";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_OUTPUT_DIR = join(homedir(), ".codex-image", "images");

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

type Quality = "auto" | "low" | "medium" | "high";
type Background = "auto" | "transparent" | "opaque";

export type GenerateImageConfig = {
	prompt: string;
	inputImagePaths?: string[];
	outputPath?: string;
	cwd?: string;
	size?: string;
	quality?: Quality;
	background?: Background;
	token?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
};

export type GenerateImageResult = {
	outputPath: string;
	revisedPrompt?: string;
	inputImagePaths: string[];
};

export type CheckAuthConfig = {
	token?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
};

export type CheckAuthResult = {
	ok: true;
	model: string;
};

export async function checkAuth(
	config: CheckAuthConfig = {},
): Promise<CheckAuthResult> {
	const token = getCodexAuth(config);
	config.onProgress?.("Calling Codex Responses API...");

	const res = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			originator: "codex-image-cli",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: CODEX_MODEL,
			store: false,
			stream: true,
			instructions: "Respond with exactly: ok",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "auth check" }],
				},
			],
		}),
		signal: config.signal,
	});

	if (!res.ok || !res.body) {
		const errText = await res.text().catch(() => "");
		throw new Error(
			`Codex Responses API auth check failed ${res.status} ${res.statusText}: ${errText.slice(0, 800)}`,
		);
	}

	const stream = await readCheckStream(res.body);
	if (stream.error)
		throw new Error(`Codex Responses API check failed: ${stream.error}`);
	config.onProgress?.("Auth check succeeded.");
	return { ok: true, model: CODEX_MODEL };
}

export async function generateImage(
	config: GenerateImageConfig,
): Promise<GenerateImageResult> {
	if (!config.prompt.trim()) throw new Error("prompt must not be empty");

	if (config.size) validateImageSize(config.size);

	const cwd = config.cwd ?? process.cwd();
	const token = getCodexAuth(config);

	const tool: Record<string, unknown> = {
		type: "image_generation",
		output_format: "png",
	};
	if (config.size && config.size !== "auto") tool.size = config.size;
	if (config.quality && config.quality !== "auto")
		tool.quality = config.quality;
	if (config.background && config.background !== "auto") {
		tool.background = config.background;
	}

	const content: Array<Record<string, unknown>> = [];
	const resolvedInputPaths: string[] = [];

	for (const rawPath of config.inputImagePaths ?? []) {
		const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
		const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
		if (!mime) {
			throw new Error(
				`Unsupported input image type for ${abs}. Supported: ${Object.keys(MIME_BY_EXT).join(", ")}`,
			);
		}
		const bytes = readFileSync(abs);
		content.push({
			type: "input_image",
			image_url: `data:${mime};base64,${bytes.toString("base64")}`,
		});
		resolvedInputPaths.push(abs);
	}

	content.push({ type: "input_text", text: config.prompt });

	config.onProgress?.("Calling Codex image_generation...");
	const res = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			originator: "codex-image-cli",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: CODEX_MODEL,
			store: false,
			stream: true,
			instructions:
				"You are an image generation passthrough. Call the image_generation tool exactly once. Copy the user's prompt verbatim into the tool's prompt argument. Do NOT paraphrase, summarize, expand, embellish, or rewrite the prompt in any way. Do not add stylistic descriptors the user did not include. After the tool call, do not produce any additional text.",
			input: [{ type: "message", role: "user", content }],
			tools: [tool],
			tool_choice: { type: "image_generation" },
		}),
		signal: config.signal,
	});

	if (!res.ok || !res.body) {
		const errText = await res.text().catch(() => "");
		throw new Error(
			`Codex Responses API error ${res.status} ${res.statusText}: ${errText.slice(0, 800)}`,
		);
	}

	const stream = await readImageStream(res.body, config.onProgress);
	if (stream.error)
		throw new Error(`Codex image_generation failed: ${stream.error}`);
	if (!stream.imageB64)
		throw new Error("Image generation completed but returned no image data");

	const outputPath = resolveOutputPath(config, cwd);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, Buffer.from(stream.imageB64, "base64"));

	return {
		outputPath,
		revisedPrompt: stream.revisedPrompt,
		inputImagePaths: resolvedInputPaths,
	};
}

type ImageStreamResult = {
	imageB64?: string;
	revisedPrompt?: string;
	error?: string;
};

type CodexSseEvent = {
	type?: string;
	[key: string]: unknown;
};

async function readCheckStream(
	body: ReadableStream<Uint8Array>,
): Promise<{ error?: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { value, done } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

		for (const chunk of drainSseChunks(done ? `${buffer}\n\n` : buffer)) {
			buffer = chunk.rest;
			const event = parseSseData(chunk.data);
			if (!event) continue;
			const error = getErrorMessage(event);
			if (error) return { error };
			if (event.type === "response.completed") return {};
		}

		if (done) return {};
	}
}

async function readImageStream(
	body: ReadableStream<Uint8Array>,
	onProgress?: (message: string) => void,
): Promise<ImageStreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const result: ImageStreamResult = {};

	while (true) {
		const { value, done } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

		for (const chunk of drainSseChunks(done ? `${buffer}\n\n` : buffer)) {
			buffer = chunk.rest;
			const event = parseSseData(chunk.data);
			if (!event) continue;
			applyImageEvent(event, result, onProgress);
			if (result.error || event.type === "response.completed") return result;
		}

		if (done) return result;
	}
}

function* drainSseChunks(
	buffer: string,
): Generator<{ data: string; rest: string }> {
	let rest = buffer;
	let sep: number;
	while ((sep = rest.indexOf("\n\n")) !== -1) {
		yield { data: rest.slice(0, sep), rest: rest.slice(sep + 2) };
		rest = rest.slice(sep + 2);
	}
}

function parseSseData(chunk: string): CodexSseEvent | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	if (!data || data === "[DONE]") return undefined;

	try {
		const parsed: unknown = JSON.parse(data);
		return isRecord(parsed) ? parsed : undefined;
	} catch (err) {
		throw new Error(`Failed to parse SSE data: ${getUnknownErrorMessage(err)}`);
	}
}

function applyImageEvent(
	event: CodexSseEvent,
	result: ImageStreamResult,
	onProgress?: (message: string) => void,
): void {
	if (event.type === "response.output_item.added") {
		onProgress?.("Generating image...");
		return;
	}

	if (event.type === "response.output_item.done") {
		copyImageFields(event.item, result);
		return;
	}

	if (event.type === "response.image_generation_call.completed") {
		copyImageFields(event, result);
		return;
	}

	if (event.type === "response.completed") {
		const response = event.response;
		if (isRecord(response) && Array.isArray(response.output)) {
			for (const entry of response.output) copyImageFields(entry, result);
		}
		return;
	}

	const error = getErrorMessage(event);
	if (error) result.error = error;
}

function copyImageFields(source: unknown, result: ImageStreamResult): void {
	if (!isRecord(source)) return;
	if (typeof source.result === "string") result.imageB64 = source.result;
	if (typeof source.revised_prompt === "string") {
		result.revisedPrompt = source.revised_prompt;
	}
}

function getErrorMessage(event: CodexSseEvent): string | undefined {
	if (event.type === "response.failed") {
		const response = event.response;
		const error = isRecord(response) ? response.error : undefined;
		return getMessage(error);
	}
	if (event.type === "error") {
		return getMessage(event.error) ?? getMessage(event);
	}
}

function getMessage(value: unknown): string | undefined {
	return isRecord(value) && typeof value.message === "string"
		? value.message
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getUnknownErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function resolveOutputPath(config: GenerateImageConfig, cwd: string): string {
	if (config.outputPath)
		return isAbsolute(config.outputPath)
			? config.outputPath
			: resolve(cwd, config.outputPath);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = config.prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return join(
		DEFAULT_OUTPUT_DIR,
		slug ? `${stamp}-${slug}.png` : `${stamp}.png`,
	);
}

function validateImageSize(size: string): void {
	if (size === "auto") return;
	const match = /^(\d+)x(\d+)$/.exec(size);
	if (!match)
		throw new Error(
			"size must be 'auto' or WIDTHxHEIGHT, for example 2048x1152",
		);
	const width = Number(match[1]);
	const height = Number(match[2]);
	const longEdge = Math.max(width, height);
	const shortEdge = Math.min(width, height);
	const pixels = width * height;
	if (longEdge > 3840)
		throw new Error("size maximum edge length must be <= 3840px");
	if (width % 16 !== 0 || height % 16 !== 0)
		throw new Error("size width and height must both be multiples of 16px");
	if (longEdge / shortEdge > 3)
		throw new Error("size long-edge to short-edge ratio must not exceed 3:1");
	if (pixels < 655_360 || pixels > 8_294_400)
		throw new Error("size total pixels must be between 655,360 and 8,294,400");
}

function getCodexAuth(config: { token?: string }): string {
	const token =
		config.token ?? process.env.OPENAI_CODEX_TOKEN ?? process.env.CODEX_TOKEN;
	if (token) return token;

	const storedToken = readPiCodexToken() ?? readCodexToken();
	if (!storedToken) {
		throw new Error(
			"Missing Codex OAuth access token. Set OPENAI_CODEX_TOKEN/CODEX_TOKEN to a ChatGPT Codex access token, login with Codex (~/.codex/auth.json), or run /login in pi/clawd and choose ChatGPT Plus/Pro (Codex). OpenAI Platform API keys (sk-...) are not supported by this endpoint.",
		);
	}
	return storedToken;
}

type PiAgentAuth = { "openai-codex"?: { access?: string } };
type CodexAuth = { tokens?: { access_token?: string } };

function readPiCodexToken(): string | undefined {
	const agentDirEnv =
		process.env.PI_CODING_AGENT_DIR ?? process.env.CLAWD_CODING_AGENT_DIR;
	const agentDir = agentDirEnv
		? expandTildePath(agentDirEnv)
		: join(homedir(), ".pi", "agent");

	return readJsonFile<PiAgentAuth>(join(agentDir, "auth.json"))?.[
		"openai-codex"
	]?.access;
}

function readCodexToken(): string | undefined {
	const codexHome = process.env.CODEX_HOME
		? expandTildePath(process.env.CODEX_HOME)
		: join(homedir(), ".codex");
	return readJsonFile<CodexAuth>(join(codexHome, "auth.json"))?.tokens
		?.access_token;
}

function readJsonFile<T>(path: string): T | undefined {
	let json: string;
	try {
		json = readFileSync(path, "utf-8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${path}: ${getUnknownErrorMessage(err)}`);
	}

	try {
		return JSON.parse(json) as T;
	} catch (err) {
		throw new Error(`Failed to parse ${path}: ${getUnknownErrorMessage(err)}`);
	}
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

const USAGE = `img-gen - generate/edit images through Codex image_generation

Usage:
  img-gen [options] <prompt>
  img-gen [options] --prompt <prompt>
  img-gen check [--json] [--verbose]

Options:
  -p, --prompt <text>        Text prompt. If omitted, remaining args are joined.
  -i, --input <path>         Conditioning/edit image path. Repeatable.
  -o, --output <path>        Output PNG path.
  -s, --size <WxH|auto>      Image size, e.g. 1024x1024, 2048x1152.
  -q, --quality <value>      auto | low | medium | high.
  -b, --background <value>   auto | transparent | opaque.
      --json                 Print JSON summary.
      --verbose              Print progress to stderr.
  -h, --help                 Show this help.

Commands:
  check                      Validate auth with a live Responses API call.

Auth:
  Env: OPENAI_CODEX_TOKEN/CODEX_TOKEN must be a ChatGPT Codex OAuth access token.
  Stored tokens are read from ~/.codex/auth.json or pi/clawd ~/.pi/agent/auth.json.
  OpenAI Platform API keys (sk-...) are not supported by this endpoint.
`;

type CliOptions = Omit<GenerateImageConfig, "onProgress"> & {
	inputImagePaths: string[];
	json: boolean;
	verbose: boolean;
};

type CheckCliOptions = {
	json: boolean;
	verbose: boolean;
};

function parseCheckArgs(argv: string[]): CheckCliOptions {
	const opts: CheckCliOptions = { json: false, verbose: false };
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--verbose") {
			opts.verbose = true;
		} else {
			throw new Error(`Unknown check option: ${arg}`);
		}
	}
	return opts;
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		prompt: "",
		inputImagePaths: [],
		json: false,
		verbose: false,
	};
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			return value;
		};

		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		} else if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (arg === "-p" || arg === "--prompt") {
			opts.prompt = next();
		} else if (arg === "-i" || arg === "--input") {
			opts.inputImagePaths.push(next());
		} else if (arg === "-o" || arg === "--output") {
			opts.outputPath = next();
		} else if (arg === "-s" || arg === "--size") {
			opts.size = next();
		} else if (arg === "-q" || arg === "--quality") {
			const value = next();
			if (!["auto", "low", "medium", "high"].includes(value))
				throw new Error("--quality must be auto, low, medium, or high");
			opts.quality = value as Quality;
		} else if (arg === "-b" || arg === "--background") {
			const value = next();
			if (!["auto", "transparent", "opaque"].includes(value))
				throw new Error("--background must be auto, transparent, or opaque");
			opts.background = value as Background;
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--verbose") {
			opts.verbose = true;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}

	if (!opts.prompt && positional.length > 0) opts.prompt = positional.join(" ");
	if (!opts.prompt.trim()) throw new Error("prompt is required");
	return opts;
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "check") {
		const opts = parseCheckArgs(argv.slice(1));
		const result = await checkAuth({
			onProgress: opts.verbose
				? (message) => process.stderr.write(`${message}\n`)
				: undefined,
		});
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			process.stdout.write(`Auth OK (${result.model})\n`);
		}
		return;
	}

	const opts = parseArgs(argv);
	const { json, verbose, ...config } = opts;
	const result = await generateImage({
		...config,
		onProgress: verbose
			? (message) => process.stderr.write(`${message}\n`)
			: undefined,
	});

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`,
		);
	} else {
		process.stdout.write(`Generated image saved to: ${result.outputPath}\n`);
		if (result.revisedPrompt)
			process.stdout.write(`Revised prompt: ${result.revisedPrompt}\n`);
		if (result.inputImagePaths.length)
			process.stdout.write(
				`Conditioned on: ${result.inputImagePaths.join(", ")}\n`,
			);
	}
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return (
			realpathSync(resolve(entry)) ===
			realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	main().catch((err: Error) => {
		process.stderr.write(`${err.message}\n`);
		process.exit(1);
	});
}
