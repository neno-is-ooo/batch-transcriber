import type { Provider } from "../../types/providers";
import { ProviderCard } from "./ProviderCard";

export interface ProviderSelectorProps {
  providers: Provider[];
  loading: boolean;
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onRefresh: () => void;
}

export function ProviderSelector({
  providers,
  loading,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  onRefresh,
}: ProviderSelectorProps) {
  const currentProvider =
    providers.find((provider) => provider.id === selectedProvider) ?? providers[0];

  return (
    <section className="provider-selector" data-testid="provider-selector">
      <div className="provider-selector__header">
        <label className="provider-selector__label" htmlFor="provider-select">
          Transcription Engine
        </label>
        <button
          type="button"
          className="provider-selector__refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {providers.length === 0 ? (
        <p className="provider-selector__empty">No providers detected yet.</p>
      ) : (
        <select
          id="provider-select"
          className="provider-selector__select"
          data-testid="provider-select"
          value={currentProvider?.id ?? ""}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.available ? provider.name : `${provider.name} (Not Installed)`}
            </option>
          ))}
        </select>
      )}

      {currentProvider ? (
        <ProviderCard
          provider={currentProvider}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
      ) : null}
    </section>
  );
}
