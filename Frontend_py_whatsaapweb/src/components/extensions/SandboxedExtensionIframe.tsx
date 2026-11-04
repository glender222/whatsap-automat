import React, { useEffect, useRef, useCallback } from 'react';
import type { SandboxedExtensionIframeProps, ExtensionRpcMessage } from './types';

/**
 * SandboxedExtensionIframe
 *
 * Renders an isolated <iframe> with sandbox="allow-scripts" strictly omitting "allow-same-origin".
 * This prevents untrusted third-party extension scripts from accessing:
 *  - window.parent
 *  - window.localStorage
 *  - document.cookie
 *  - Host session tokens and IndexedDB
 *
 * Provides a typed JSON-RPC 2.0 postMessage bridge for controlled host-guest communication.
 */
export const SandboxedExtensionIframe: React.FC<SandboxedExtensionIframeProps> = ({
  extensionId,
  srcDoc,
  src,
  title,
  width = '100%',
  height = '100%',
  className = '',
  context,
  onRpcCall,
  onReady,
  onError,
}: SandboxedExtensionIframeProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onRpcCallRef = useRef(onRpcCall);
  const onErrorRef = useRef(onError);

  // Keep callback reference updated across renders without re-attaching listeners
  useEffect(() => {
    onRpcCallRef.current = onRpcCall;
    onErrorRef.current = onError;
  }, [onRpcCall, onError]);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      // 1. Verify message origin/source: Discard any message not from our specific iframe
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      const data = event.data as ExtensionRpcMessage;

      // 2. Enforce JSON-RPC 2.0 schema validation
      if (
        !data ||
        typeof data !== 'object' ||
        data.jsonrpc !== '2.0' ||
        typeof data.id !== 'string' ||
        typeof data.method !== 'string'
      ) {
        return;
      }

      const contentWindow = iframeRef.current.contentWindow;
      if (!contentWindow) return;

      // 3. Dispatch to host RPC handler
      if (!onRpcCallRef.current) {
        contentWindow.postMessage(
          {
            jsonrpc: '2.0',
            id: data.id,
            error: {
              code: -32601,
              message: `No RPC handler configured for method: ${data.method}`,
            },
          },
          '*'
        );
        return;
      }

      try {
        const result = await onRpcCallRef.current(data.method, data.params);
        contentWindow.postMessage(
          {
            jsonrpc: '2.0',
            id: data.id,
            result: result !== undefined ? result : null,
          },
          '*'
        );
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        onErrorRef.current?.(errorObj);
        contentWindow.postMessage(
          {
            jsonrpc: '2.0',
            id: data.id,
            error: {
              code: -32603,
              message: errorObj.message || 'Internal RPC execution error',
            },
          },
          '*'
        );
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleMessage]);

  const handleIframeLoad = () => {
    // Send initialization payload to guest
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          jsonrpc: '2.0',
          method: 'extension:init',
          params: {
            extensionId,
            context: context || {},
          },
        },
        '*'
      );
    }
    if (onReady) {
      onReady();
    }
  };

  return (
    <iframe
      ref={iframeRef}
      // CRITICAL SECURITY INVARIANT:
      // "allow-scripts" enables JavaScript execution inside the iframe.
      // "allow-same-origin" is INTENTIONALLY AND STRICTLY OMITTED.
      // With origin="null", the iframe cannot access window.parent, cookies, or localStorage.
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      src={src}
      title={title || `extension-sandbox-${extensionId}`}
      width={width}
      height={height}
      className={`sandboxed-extension-slot ${className}`.trim()}
      style={{
        border: 'none',
        display: 'block',
        width,
        height,
      }}
      onLoad={handleIframeLoad}
      onError={() => onErrorRef.current?.(new Error('Failed to load sandboxed extension iframe'))}
      data-testid={`sandboxed-extension-${extensionId}`}
    />
  );
};

export default SandboxedExtensionIframe;
