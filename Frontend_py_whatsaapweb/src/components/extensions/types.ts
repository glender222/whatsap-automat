export interface ExtensionRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ExtensionRpcResponseSuccess {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly result: unknown;
}

export interface ExtensionRpcResponseError {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type ExtensionRpcResponse = ExtensionRpcResponseSuccess | ExtensionRpcResponseError;

export interface SandboxedExtensionIframeProps {
  readonly extensionId: string;
  readonly srcDoc?: string;
  readonly src?: string;
  readonly title?: string;
  readonly width?: string | number;
  readonly height?: string | number;
  readonly className?: string;
  readonly context?: Record<string, unknown>;
  readonly onRpcCall?: (method: string, params: unknown) => Promise<unknown>;
  readonly onReady?: () => void;
  readonly onError?: (error: Error) => void;
}
