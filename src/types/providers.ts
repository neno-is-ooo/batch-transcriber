export interface SwiftNativeRuntime {
  type: "SwiftNative";
  binaryPath: string;
  modelDir: string;
}

export interface PythonUvRuntime {
  type: "PythonUv";
  package: string;
  entryPoint: string;
}

export interface CloudAPIRuntime {
  type: "CloudAPI";
  baseUrl: string;
  requiresKey: boolean;
}

export type ProviderRuntime =
  | SwiftNativeRuntime
  | PythonUvRuntime
  | CloudAPIRuntime;

export interface Capabilities {
  supportedModels?: string[];
  supportedFormats?: string[];
  maxFileSize?: number;
  concurrentFiles?: number;
  wordTimestamps?: boolean;
  speakerDiarization?: boolean;
  languageDetection?: boolean;
  translation?: boolean;
  languages?: string[];
  speedEstimate?: number;
  maxFileSizeMb?: number;
}

export interface Provider {
  id: string;
  name: string;
  runtime: ProviderRuntime;
  available: boolean;
  capabilities?: Capabilities | null;
  installInstructions?: string | null;
}

export function isSwiftNativeRuntime(
  runtime: ProviderRuntime
): runtime is SwiftNativeRuntime {
  return runtime.type === "SwiftNative";
}

export function isPythonUvRuntime(
  runtime: ProviderRuntime
): runtime is PythonUvRuntime {
  return runtime.type === "PythonUv";
}

export function isCloudAPIRuntime(
  runtime: ProviderRuntime
): runtime is CloudAPIRuntime {
  return runtime.type === "CloudAPI";
}
