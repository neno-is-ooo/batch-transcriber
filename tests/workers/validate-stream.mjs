import { readFileSync } from "node:fs";
import process from "node:process";
import Ajv from "ajv";

const schemaPath = process.argv[2];
if (!schemaPath) {
  process.stderr.write("Usage: node validate-stream.mjs <schema-path>\n");
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

let stdin = "";
for await (const chunk of process.stdin) {
  stdin += String(chunk);
}

const lines = stdin
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

let failures = 0;
lines.forEach((line, index) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    failures += 1;
    process.stderr.write(
      `[line ${index + 1}] invalid JSON: ${error instanceof Error ? error.message : "unknown parse error"}\n`
    );
    return;
  }

  const valid = validate(parsed);
  if (!valid) {
    failures += 1;
    const details = (validate.errors ?? [])
      .map((entry) => `${entry.instancePath || "$"} ${entry.message || "is invalid"}`)
      .join("; ");
    process.stderr.write(`[line ${index + 1}] schema validation failed: ${details}\n`);
  }
});

if (failures > 0) {
  process.exit(1);
}

process.stdout.write(`Validated ${lines.length} NDJSON event(s).\n`);
