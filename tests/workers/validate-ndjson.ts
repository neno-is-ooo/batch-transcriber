import Ajv, { type ErrorObject } from "ajv";
import protocolSchema from "./protocol-schema.json";

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

interface NDJSONValidationError {
  line: number;
  errors: string[];
}

interface NDJSONValidationResult {
  valid: boolean;
  errors: NDJSONValidationError[];
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

const validateProtocolEvent = ajv.compile(protocolSchema);

function formatError(error: ErrorObject): string {
  const path = error.instancePath || "$";
  return `${path} ${error.message ?? "is invalid"}`;
}

export function validateEvent(event: unknown): ValidationResult {
  const valid = validateProtocolEvent(event);
  if (valid) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: (validateProtocolEvent.errors ?? []).map((error) => formatError(error)),
  };
}

export function validateNDJSON(lines: string[]): NDJSONValidationResult {
  const errors: NDJSONValidationError[] = [];

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      const result = validateEvent(parsed);
      if (!result.valid) {
        errors.push({
          line: index + 1,
          errors: result.errors ?? ["Unknown schema validation error"],
        });
      }
    } catch (error) {
      errors.push({
        line: index + 1,
        errors: [
          `Invalid JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`,
        ],
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}
