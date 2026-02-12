import { useEffect, useState } from "react";
import type { Capabilities, Provider } from "../../types/providers";
import { getModelsForProvider } from "./providerModels";

export interface ProviderCardProps {
  provider: Provider;
  selectedModel: string;
  onModelChange: (model: string) => void;
}

interface ModelSelectorProps {
  providerId: string;
  selectedModel: string;
  onModelChange: (model: string) => void;
}

type CopyState = "idle" | "copied" | "error";

function formatSpeed(speedEstimate?: number): string {
  if (typeof speedEstimate !== "number" || !Number.isFinite(speedEstimate) || speedEstimate <= 0) {
    return "n/a";
  }

  return `${speedEstimate}x`;
}

function formatBoolean(value?: boolean): string {
  if (typeof value !== "boolean") {
    return "Unknown";
  }

  return value ? "Yes" : "No";
}

function formatLanguageCount(languages?: string[]): string {
  if (!Array.isArray(languages)) {
    return "Unknown";
  }

  return String(languages.length);
}

function extractCommand(instructions: string): string {
  const commandMatch = instructions.match(/`([^`]+)`/);
  return commandMatch?.[1] ?? instructions;
}

function CapabilityBadge({
  icon,
  label,
  value,
  enabled,
}: {
  icon: string;
  label: string;
  value?: string;
  enabled?: boolean;
}) {
  const stateClass =
    typeof enabled !== "boolean"
      ? ""
      : enabled
        ? "capability-badge--enabled"
        : "capability-badge--disabled";

  return (
    <div className={`capability-badge ${stateClass}`.trim()}>
      <span className="capability-badge__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="capability-badge__label">{label}</span>
      {value ? <span className="capability-badge__value">{value}</span> : null}
      {typeof enabled === "boolean" ? (
        <span className="capability-badge__value">{enabled ? "Enabled" : "Disabled"}</span>
      ) : null}
    </div>
  );
}

function CapabilitiesGrid({ capabilities }: { capabilities: Capabilities }) {
  return (
    <div className="capabilities-grid" data-testid="capabilities-grid">
      <CapabilityBadge
        icon="SPD"
        label="Speed"
        value={formatSpeed(capabilities.speedEstimate)}
      />
      <CapabilityBadge
        icon="TS"
        label="Word Timestamps"
        value={formatBoolean(capabilities.wordTimestamps)}
        enabled={capabilities.wordTimestamps}
      />
      <CapabilityBadge
        icon="SPK"
        label="Speaker Diarization"
        value={formatBoolean(capabilities.speakerDiarization)}
        enabled={capabilities.speakerDiarization}
      />
      <CapabilityBadge
        icon="LANG"
        label="Languages"
        value={formatLanguageCount(capabilities.languages)}
      />
    </div>
  );
}

function ModelSelector({ providerId, selectedModel, onModelChange }: ModelSelectorProps) {
  const models = getModelsForProvider(providerId);

  if (models.length === 0) {
    return null;
  }

  return (
    <div className="provider-card__field-group">
      <label className="provider-card__label" htmlFor="model-select">
        Model
      </label>
      <select
        id="model-select"
        className="provider-card__model-select"
        data-testid="model-select"
        value={selectedModel}
        onChange={(event) => onModelChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} - {model.description}
          </option>
        ))}
      </select>
    </div>
  );
}

function InstallInstructions({ instructions }: { instructions: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopyState("idle");
    }, 2_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copyState]);

  const handleCopy = async () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      setCopyState("error");
      return;
    }

    try {
      await clipboard.writeText(extractCommand(instructions));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="install-instructions" data-testid="install-instructions">
      <p className="install-instructions__text">
        <span className="install-instructions__icon" aria-hidden="true">
          !
        </span>
        {instructions}
      </p>
      <button
        type="button"
        className="install-instructions__copy"
        onClick={() => {
          void handleCopy();
        }}
      >
        Copy Command
      </button>
      {copyState === "copied" ? (
        <p className="install-instructions__status" role="status">
          Copied command.
        </p>
      ) : null}
      {copyState === "error" ? (
        <p className="install-instructions__status install-instructions__status--error" role="status">
          Clipboard unavailable.
        </p>
      ) : null}
    </div>
  );
}

export function ProviderCard({ provider, selectedModel, onModelChange }: ProviderCardProps) {
  const statusClass = provider.available
    ? "provider-card__badge provider-card__badge--ready"
    : "provider-card__badge provider-card__badge--warning";

  return (
    <article className="provider-card" data-testid="provider-card">
      <header className="provider-card__header">
        <h3 className="provider-card__name">{provider.name}</h3>
        <span className={statusClass}>{provider.available ? "Ready" : "Not Installed"}</span>
      </header>

      {provider.available && provider.capabilities ? (
        <CapabilitiesGrid capabilities={provider.capabilities} />
      ) : null}

      {provider.available ? (
        <ModelSelector
          providerId={provider.id}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
      ) : null}

      {!provider.available && provider.installInstructions ? (
        <InstallInstructions instructions={provider.installInstructions} />
      ) : null}
    </article>
  );
}
