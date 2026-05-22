// claude -p subprocess wrapper. See SPEC §6 (auth/cost) and §2 decision 9.
//
// Auth model (SPEC §6): we DO NOT pass --bare. Plain `claude -p` reuses the
// local Claude Code session (Pro/Max OAuth) when ANTHROPIC_API_KEY is unset,
// and uses the API key when it is set. Either way the interface is identical.
import { spawn } from "node:child_process";

export interface ClaudeOptions {
  /** JSON Schema object for structured output (passed to --json-schema). */
  schema?: unknown;
  /** Tool names the model may use, e.g. ["Read", "Grep", "Glob"]. */
  allowedTools?: string[];
  /** Extra directories the model is allowed to read (passed to --add-dir). */
  addDirs?: string[];
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Optional hard spend cap (passed to --max-budget-usd). */
  maxBudgetUsd?: number;
  /** Optional model alias/id override. */
  model?: string;
  /** Kill the call after this many ms. Default 5 min. */
  timeoutMs?: number;
}

export interface ClaudeResult {
  /** The model's final text output. */
  text: string;
  /** Schema-conforming object when --json-schema was used (CLI parses it for us). */
  structured?: unknown;
  /** Reported cost for the call, if the CLI provided it. */
  costUsd?: number;
  /** Number of turns the agent took, if reported. */
  numTurns?: number;
}

export class ClaudeError extends Error {}

/** The JSON envelope `claude -p --output-format json` prints on stdout. */
interface ResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  /** Present when --json-schema is used: the validated structured object. */
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
}

/**
 * Invoke `claude -p` once. The prompt is written to stdin (no arg-length
 * limit). Returns the final text plus cost metadata.
 */
export async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  const args = ["-p", "--output-format", "json"];

  if (opts.schema !== undefined) {
    args.push("--json-schema", JSON.stringify(opts.schema));
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    // Comma-separated; restricting the toolset is what bounds the agent.
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }

  const { stdout, stderr, code } = await spawnCapture("claude", args, {
    cwd: opts.cwd,
    input: prompt,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });

  if (code !== 0) {
    throw new ClaudeError(
      `claude -p exited with code ${code}.\nstderr: ${stderr.trim()}\nstdout: ${stdout.slice(0, 2000)}`,
    );
  }

  const envelope = parseEnvelope(stdout);
  if (envelope.is_error) {
    throw new ClaudeError(`claude -p reported an error: ${envelope.result ?? "(no detail)"}`);
  }
  if (envelope.result === undefined) {
    throw new ClaudeError(`claude -p returned no result field. Raw: ${stdout.slice(0, 2000)}`);
  }

  return {
    text: envelope.result,
    structured: envelope.structured_output,
    costUsd: envelope.total_cost_usd,
    numTurns: envelope.num_turns,
  };
}

/**
 * Invoke `claude -p` with a schema and parse the structured result.
 * Tolerates the model wrapping its JSON in markdown code fences.
 */
export async function runClaudeJson<T>(
  prompt: string,
  schema: unknown,
  opts: Omit<ClaudeOptions, "schema"> = {},
): Promise<{ data: T; costUsd?: number }> {
  const res = await runClaude(prompt, { ...opts, schema });
  // The CLI validates and parses the schema output into `structured_output`.
  // Fall back to scraping the text only if that field is somehow absent.
  const data =
    res.structured !== undefined && res.structured !== null
      ? (res.structured as T)
      : parseJsonResult<T>(res.text);
  return { data, costUsd: res.costUsd };
}

function parseEnvelope(stdout: string): ResultEnvelope {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as ResultEnvelope;
  } catch {
    // Some environments emit log lines before the JSON; grab the last JSON line.
    const lines = trimmed.split("\n").filter((l) => l.trim().startsWith("{"));
    const last = lines.at(-1);
    if (last) {
      try {
        return JSON.parse(last) as ResultEnvelope;
      } catch {
        /* fall through */
      }
    }
    throw new ClaudeError(`Could not parse claude -p JSON envelope. Raw: ${stdout.slice(0, 2000)}`);
  }
}

/** Extract a JSON object from the model's result text, tolerating fences/prose. */
export function parseJsonResult<T>(text: string): T {
  const trimmed = text.trim();
  // Direct parse.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* try harder */
  }
  // Strip markdown code fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* try harder */
    }
  }
  // Grab the outermost {...} span.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      /* give up */
    }
  }
  throw new ClaudeError(`Model output was not valid JSON:\n${text.slice(0, 2000)}`);
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ClaudeError(`claude -p timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeError(`Failed to spawn claude: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}
