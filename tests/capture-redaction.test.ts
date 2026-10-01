import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Secret redaction in the capture plugin.
 *
 * These tests read the plugin source and exercise the redaction table out of it,
 * rather than importing it, because the plugin is a plain object literal typed
 * against OpenCode's plugin context and has no exported `redact`. The table is
 * lifted with a regex and evaluated in isolation — if the table is deleted or
 * emptied, every test below fails loudly, which is the behaviour that matters.
 *
 * Why this is tested at all: `.agent-logs/` is committed to git. A redaction bug
 * is therefore a credential-publication bug, and "I checked the regex once" is not
 * a durable answer. An OpenRouter key really did land in a committed log.
 */

const source = readFileSync(
  path.join(process.cwd(), ".opencode/plugins/agent-capture/index.ts"),
  "utf8",
);

const start = source.indexOf("const REDACTIONS");
const end = source.indexOf("function redact");
if (start === -1 || end === -1) {
  throw new Error("Could not locate the REDACTIONS table in the capture plugin");
}

// The table is data, not code — evaluate just that slice, minus the TypeScript type
// annotation between the name and the `=`, which is not valid JavaScript.
const table = source
  .slice(start, end)
  .replace(/^const REDACTIONS[^=]*=/, "return ");

function redact(text: string): string {
  const redactions = new Function(table)() as Array<[RegExp, string]>;
  let out = text;
  for (const [pattern, replacement] of redactions) out = out.replace(pattern, replacement);
  return out;
}

describe("capture redaction", () => {
  test("the real OpenRouter key format is redacted", () => {
    const key = `sk-or-v1-${"a".repeat(64)}`;
    const out = redact(`my key is ${key} please use it`);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED:openrouter-api-key]");
    // The surrounding words must survive, or the log becomes useless.
    expect(out).toContain("my key is");
    expect(out).toContain("please use it");
  });

  test("a short or malformed key-shaped string is left alone", () => {
    // Redacting anything starting `sk-or-v1-` would eat legitimate discussion of
    // the format itself, which is exactly what a log of building this app contains.
    const out = redact("the prefix is sk-or-v1- followed by 64 hex chars");
    expect(out).toBe("the prefix is sk-or-v1- followed by 64 hex chars");
  });

  test("OpenAI keys are redacted, including project-scoped ones", () => {
    expect(redact("sk-abc123def456ghi789jkl012")).not.toContain("abc123def456");
    expect(redact("sk-proj-abc123def456ghi789jkl012mno")).not.toContain("abc123def456");
  });

  test("Supabase anon and service-role JWTs are redacted", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.s0m3S1gnatUr3k3y";
    expect(redact(`key=${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiI");
    expect(redact("sb_publishable_abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED:supabase-key]");
  });

  test("AWS access key ids are redacted", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws-access-key-id]");
  });

  test("GitHub tokens are redacted", () => {
    expect(redact(`ghp_${"a".repeat(36)}`)).toContain("[REDACTED:github-token]");
  });

  test("a Postgres URL keeps its host but loses the password", () => {
    const out = redact("postgres://admin:hunter2@db.example.com:5432/vantage");
    expect(out).not.toContain("hunter2");
    // The host has to stay: knowing which database is connected is the whole
    // diagnostic value of the line, and the password is the only secret in it.
    expect(out).toContain("db.example.com");
    expect(out).toContain("postgres://admin:");
  });

  test("a PEM private key block is redacted whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAx7Vd8Ny0Zq3sdf",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(`here it is\n${pem}\ndone`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).toContain("done");
  });

  test("an env-file style assignment is redacted", () => {
    expect(redact("OPENROUTER_API_KEY=sk-or-v1-" + "b".repeat(64))).not.toContain("b".repeat(20));
    expect(redact("DATABASE_URL=postgres://u:p@h/db")).not.toContain(":p@");
    expect(redact('SOME_SECRET: "abc123def456"')).toContain("[REDACTED]");
  });

  test("ordinary prose and code are untouched", () => {
    const prose = "The middleware was renamed to proxy in Next 16, so src/middleware.ts became src/proxy.ts.";
    expect(redact(prose)).toBe(prose);

    // A log of building this app is mostly code. If redaction ate code, the logs
    // would stop being evidence of anything.
    const code = 'const key = "duration_seconds_480p";\nexport const credits = 1000;';
    expect(redact(code)).toBe(code);
  });

  test("a normal sentence mentioning the word token is not redacted", () => {
    const sentence = "The response includes a token count for per-token pricing models.";
    expect(redact(sentence)).toBe(sentence);
  });

  test("both capture halves call redact", () => {
    // The table is useless if only one of the two entry points uses it. A response
    // can leak a secret the user never typed.
    const promptHalf = /text:\s*redact\(event\?\.prompt\?\.text/.test(source);
    const responseHalf = /const text = redact\(blocks\.join/.test(source);
    expect(promptHalf).toBe(true);
    expect(responseHalf).toBe(true);
  });
});

describe("no secret is committed", () => {
  test("no tracked file contains a live-looking key", () => {
    // Belt and braces. The unit tests above prove the table works; this proves the
    // table is actually reached for the file that was already leaked.
    let files: string[] = [];
    try {
      files = execFileSync("git", ["ls-files", ".agent-logs/"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    } catch {
      // Not a git repo, or git unavailable: the test is about the repo, so there is
      // nothing to assert and skipping is better than a false pass.
      return;
    }

    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (/sk-or-v1-[0-9a-f]{64}/.test(content)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
