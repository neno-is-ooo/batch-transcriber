import type { ReactNode } from "react";

interface TranscriptContentProps {
  content: string | null;
  format: string;
  loading: boolean;
  error: string | null;
}

const TIMESTAMP_PATTERN =
  /^(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{2}:)?\d{2}:\d{2}[.,]\d{3}$/;
const CUE_INDEX_PATTERN = /^\d+$/;
const JSON_PRIMITIVE_PATTERN = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(,?)$/;
const JSON_PUNCTUATION_TOKENS = new Set(["{", "}", "[", "]", "{,", "},", "[,", "],"]);

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function renderValue(value: string): ReactNode {
  const stringMatch = value.match(/^("(?:[^"\\]|\\.)*")(,?)$/);
  if (stringMatch) {
    return (
      <>
        <span className="quick-look__json-value quick-look__json-value--string">
          {stringMatch[1]}
        </span>
        {stringMatch[2]}
      </>
    );
  }

  const primitiveMatch = value.match(JSON_PRIMITIVE_PATTERN);
  if (primitiveMatch) {
    const token = primitiveMatch[1];
    const suffix = primitiveMatch[2];

    if (token === "true" || token === "false") {
      return (
        <>
          <span className="quick-look__json-value quick-look__json-value--boolean">{token}</span>
          {suffix}
        </>
      );
    }

    if (token === "null") {
      return (
        <>
          <span className="quick-look__json-value quick-look__json-value--null">{token}</span>
          {suffix}
        </>
      );
    }

    return (
      <>
        <span className="quick-look__json-value quick-look__json-value--number">{token}</span>
        {suffix}
      </>
    );
  }

  const trimmed = value.trim();
  if (JSON_PUNCTUATION_TOKENS.has(trimmed)) {
    return <span className="quick-look__json-punctuation">{value}</span>;
  }

  return value;
}

function renderJsonLine(line: string): ReactNode {
  const keyMatch = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/);
  if (keyMatch) {
    const [, indentation, key, separator, value] = keyMatch;

    return (
      <>
        {indentation}
        <span className="quick-look__json-key">{key}</span>
        <span className="quick-look__json-colon">{separator}</span>
        {renderValue(value)}
      </>
    );
  }

  return renderValue(line);
}

function renderPlainLines(content: string, testId: string): ReactNode {
  return (
    <ol className="quick-look__line-list" data-testid={testId}>
      {splitLines(content).map((line, index) => (
        <li key={`${index}-${line}`} className="quick-look__line">
          {line.length > 0 ? line : " "}
        </li>
      ))}
    </ol>
  );
}

function renderSubtitleLines(content: string): ReactNode {
  const lines = splitLines(content);

  return (
    <ol className="quick-look__line-list quick-look__line-list--subtitle" data-testid="quick-look-subtitle-content">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        const className =
          trimmed === "WEBVTT"
            ? "quick-look__line quick-look__line--subtitle-header"
            : TIMESTAMP_PATTERN.test(trimmed)
              ? "quick-look__line quick-look__line--timestamp"
              : CUE_INDEX_PATTERN.test(trimmed)
                ? "quick-look__line quick-look__line--cue-index"
                : "quick-look__line";

        return (
          <li key={`${index}-${line}`} className={className}>
            {line.length > 0 ? line : " "}
          </li>
        );
      })}
    </ol>
  );
}

function renderJsonContent(content: string): ReactNode {
  let pretty = content;
  let warning: string | null = null;

  try {
    pretty = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    warning = "Invalid JSON detected. Showing raw content.";
  }

  return (
    <>
      {warning ? <p className="quick-look__content-warning">{warning}</p> : null}
      <ol className="quick-look__line-list quick-look__line-list--json" data-testid="quick-look-json-content">
        {splitLines(pretty).map((line, index) => (
          <li key={`${index}-${line}`} className="quick-look__line">
            {renderJsonLine(line)}
          </li>
        ))}
      </ol>
    </>
  );
}

function normalizeFormat(format: string): string {
  const normalized = format.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "text";
}

export function TranscriptContent({ content, format, loading, error }: TranscriptContentProps) {
  const normalizedFormat = normalizeFormat(format);

  if (loading) {
    return (
      <div className="quick-look__state" role="status" data-testid="quick-look-loading">
        Loading transcript...
      </div>
    );
  }

  if (error) {
    return (
      <div className="quick-look__state quick-look__state--error" data-testid="quick-look-error">
        {error}
      </div>
    );
  }

  if (!content) {
    return (
      <div className="quick-look__state" data-testid="quick-look-empty">
        No transcript available for this item yet.
      </div>
    );
  }

  if (normalizedFormat === "json") {
    return <>{renderJsonContent(content)}</>;
  }

  if (normalizedFormat === "srt" || normalizedFormat === "vtt") {
    return <>{renderSubtitleLines(content)}</>;
  }

  return <>{renderPlainLines(content, "quick-look-plain-content")}</>;
}
