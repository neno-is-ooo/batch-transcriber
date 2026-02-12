import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../types/providers";
import { resolveModelSelection } from "./providerModels";
import { ProviderSelector, type ProviderSelectorProps } from "./ProviderSelector";

function createProvider(overrides: Partial<Provider>): Provider {
  return {
    id: "parakeet-coreml",
    name: "Parakeet CoreML",
    available: true,
    runtime: {
      type: "SwiftNative",
      binaryPath: "/tmp/parakeet-batch",
      modelDir: "/tmp/models",
    },
    ...overrides,
  };
}

function renderSelector(overrides: Partial<ProviderSelectorProps> = {}) {
  const providers: Provider[] = [
    createProvider({
      id: "parakeet-coreml",
      name: "Parakeet CoreML",
      available: true,
      capabilities: {
        speedEstimate: 2.4,
        wordTimestamps: true,
        speakerDiarization: false,
        languages: ["en", "fr", "de"],
      },
    }),
    createProvider({
      id: "whisper-openai",
      name: "Whisper (OpenAI)",
      available: true,
      runtime: {
        type: "PythonUv",
        package: "whisper-batch",
        entryPoint: "whisper_batch",
      },
      capabilities: {
        speedEstimate: 1.6,
        wordTimestamps: true,
        speakerDiarization: true,
        languages: ["en"],
      },
    }),
    createProvider({
      id: "faster-whisper",
      name: "Faster Whisper",
      available: false,
      runtime: {
        type: "PythonUv",
        package: "faster-whisper-batch",
        entryPoint: "faster_whisper_batch",
      },
      installInstructions: "Run `uv run --package faster-whisper-batch -- --version`.",
    }),
  ];

  const props: ProviderSelectorProps = {
    providers,
    loading: false,
    selectedProvider: "parakeet-coreml",
    selectedModel: "v3",
    onProviderChange: vi.fn(),
    onModelChange: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };

  render(<ProviderSelector {...props} />);
  return props;
}

function ProviderSelectorHarness({ providers }: { providers: Provider[] }) {
  const [selectedProvider, setSelectedProvider] = useState("parakeet-coreml");
  const [selectedModel, setSelectedModel] = useState("v3");

  return (
    <ProviderSelector
      providers={providers}
      loading={false}
      selectedProvider={selectedProvider}
      selectedModel={selectedModel}
      onProviderChange={(providerId) => {
        setSelectedProvider(providerId);
        setSelectedModel(resolveModelSelection(providerId, "", "v3"));
      }}
      onModelChange={setSelectedModel}
      onRefresh={() => undefined}
    />
  );
}

describe("ProviderSelector", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders provider options and capabilities for available providers", () => {
    renderSelector();

    const providerSelect = screen.getByTestId("provider-select");
    expect(providerSelect).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Parakeet CoreML" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Whisper (OpenAI)" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Faster Whisper (Not Installed)" })).toBeEnabled();

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByTestId("capabilities-grid")).toBeInTheDocument();
    expect(screen.getByText("Speed")).toBeInTheDocument();
    expect(screen.getByText("2.4x")).toBeInTheDocument();
    expect(screen.getByText("Word Timestamps")).toBeInTheDocument();
    expect(screen.getByText("Speaker Diarization")).toBeInTheDocument();
    expect(screen.getByText("Languages")).toBeInTheDocument();
  });

  it("renders installation instructions and copies command for unavailable provider", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderSelector({
      selectedProvider: "faster-whisper",
      selectedModel: "large-v3",
    });

    expect(screen.getByText("Not Installed")).toBeInTheDocument();
    expect(screen.getByTestId("install-instructions")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Command" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("uv run --package faster-whisper-batch -- --version");
    });

    expect(screen.getByRole("status")).toHaveTextContent("Copied command.");
  });

  it("updates model options when provider selection changes", () => {
    const providers: Provider[] = [
      createProvider({
        id: "parakeet-coreml",
        name: "Parakeet CoreML",
        available: true,
      }),
      createProvider({
        id: "whisper-openai",
        name: "Whisper (OpenAI)",
        available: true,
        runtime: {
          type: "PythonUv",
          package: "whisper-batch",
          entryPoint: "whisper_batch",
        },
      }),
    ];

    render(<ProviderSelectorHarness providers={providers} />);

    expect(screen.getByRole("option", { name: /v3 \(Multilingual\)/i })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("provider-select"), {
      target: { value: "whisper-openai" },
    });

    expect(screen.getByRole("option", { name: /Large v3 - Best quality/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /v2 \(English\)/i })).not.toBeInTheDocument();
  });

  it("calls refresh handler from refresh button", () => {
    const props = renderSelector();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});
