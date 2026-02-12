import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "globals.css");
const styles = readFileSync(stylesPath, "utf8");

describe("globals.css", () => {
  it("uses macOS system font stacks and Apple HIG text sizes", () => {
    expect(styles).toContain("--font-sans: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif;");
    expect(styles).toContain("--font-mono: \"SF Mono\", ui-monospace, \"Menlo\", monospace;");
    expect(styles).toContain("--text-base: 15px;");
    expect(styles).not.toMatch(/\bInter\b/);
  });

  it("defines light-dark semantic colors and system tokens", () => {
    expect(styles).toContain("color-scheme: light dark;");
    expect(styles).toContain("--color-canvas: Canvas;");
    expect(styles).toContain("--color-accent: AccentColor;");
    expect(styles).toContain("--color-accent-text: AccentColorText;");
    expect(styles).toContain("--color-surface: light-dark(#ffffff, #1e1e1e);");
    expect(styles).toContain("--color-text-primary: light-dark(#1d1d1f, #f5f5f7);");
    expect(styles).toContain("--color-success: light-dark(#34c759, #30d158);");
    expect(styles).toContain("--color-warning: light-dark(#ff9500, #ff9f0a);");
    expect(styles).toContain("--color-error: light-dark(#ff3b30, #ff453a);");
  });

  it("includes vibrancy utilities and custom titlebar styles", () => {
    expect(styles).toContain(".panel-blur {");
    expect(styles).toContain(".sidebar-blur {");
    expect(styles).toContain("@supports not (backdrop-filter: blur(1px)) {");
    expect(styles).toContain(".titlebar {");
    expect(styles).toContain("-webkit-app-region: drag;");
    expect(styles).toContain(".titlebar .traffic-lights {");
    expect(styles).toContain(".titlebar .window-title {");
  });
});
