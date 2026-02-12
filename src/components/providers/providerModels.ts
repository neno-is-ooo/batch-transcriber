export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

export const PROVIDER_MODELS: Record<string, ProviderModel[]> = {
  "parakeet-coreml": [
    {
      id: "v3",
      name: "v3 (Multilingual)",
      description: "Best quality, 99+ languages",
    },
    {
      id: "v2",
      name: "v2 (English)",
      description: "Faster, English only",
    },
  ],
  "whisper-openai": [
    {
      id: "large-v3",
      name: "Large v3",
      description: "Best quality",
    },
    {
      id: "medium",
      name: "Medium",
      description: "Balanced",
    },
    {
      id: "small",
      name: "Small",
      description: "Faster",
    },
    {
      id: "base",
      name: "Base",
      description: "Fastest",
    },
  ],
  "faster-whisper": [
    {
      id: "large-v3",
      name: "Large v3",
      description: "Best quality + speed",
    },
    {
      id: "medium",
      name: "Medium",
      description: "Balanced",
    },
    {
      id: "small",
      name: "Small",
      description: "Lower VRAM",
    },
  ],
};

export function getModelsForProvider(providerId: string): ProviderModel[] {
  return PROVIDER_MODELS[providerId] ?? [];
}

export function resolveModelSelection(
  providerId: string,
  preferredModel: string,
  fallbackModel = ""
): string {
  const models = getModelsForProvider(providerId);

  if (models.length === 0) {
    return preferredModel || fallbackModel;
  }

  if (preferredModel && models.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }

  return models[0].id;
}
