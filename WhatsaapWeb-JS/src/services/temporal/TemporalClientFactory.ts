import path from 'path';
import {
  ITemporalClient,
  TemporalClientOptions,
  TemporalConnectionError,
} from './types';

export class TemporalClientFactory {
  private clientInstance: ITemporalClient | null = null;
  private clientPromise: Promise<ITemporalClient> | null = null;
  private customProvider: ((options?: TemporalClientOptions) => Promise<ITemporalClient>) | null = null;

  private defaultAddress: string;
  private defaultNamespace: string;
  private defaultIdentity: string;

  constructor() {
    this.defaultAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
    this.defaultNamespace = process.env.TEMPORAL_NAMESPACE || 'default';
    this.defaultIdentity = process.env.TEMPORAL_CLIENT_IDENTITY || 'whatsap-automat-backend';
  }

  /**
   * Sets a custom client provider or test mock factory.
   */
  setClientProvider(provider: ((options?: TemporalClientOptions) => Promise<ITemporalClient>) | null): void {
    this.customProvider = provider;
    this.reset();
  }

  /**
   * Registers a pre-instantiated mock client for testing.
   */
  setMockClient(client: ITemporalClient | null): void {
    if (client) {
      this.customProvider = async () => client;
    } else {
      this.customProvider = null;
    }
    this.reset();
  }

  /**
   * Dynamically loads the @temporalio/client package if available.
   */
  private resolveTemporalSdk(): any {
    try {
      // 1. Try standard module resolution
      return require('@temporalio/client');
    } catch {
      // 2. Try known spike/workspace path if running in local monorepo
      const spikePath = path.resolve(__dirname, '../../../../spikes/temporal/node_modules/@temporalio/client');
      try {
        return require(spikePath);
      } catch {
        return null;
      }
    }
  }

  /**
   * Gets or initializes the singleton Temporal client.
   */
  async getClient(options?: TemporalClientOptions): Promise<ITemporalClient> {
    if (this.clientInstance) {
      return this.clientInstance;
    }

    if (this.clientPromise) {
      return this.clientPromise;
    }

    this.clientPromise = this.initClient(options);
    try {
      this.clientInstance = await this.clientPromise;
      return this.clientInstance;
    } catch (err) {
      this.clientPromise = null;
      throw err;
    }
  }

  private async initClient(options?: TemporalClientOptions): Promise<ITemporalClient> {
    if (this.customProvider) {
      return await this.customProvider(options);
    }

    const sdk = this.resolveTemporalSdk();
    if (!sdk) {
      throw new TemporalConnectionError(
        'Temporal SDK (@temporalio/client) is not installed in the runtime environment. ' +
        'Please install @temporalio/client or register a mock client via TemporalClientFactory.setMockClient().'
      );
    }

    const { Connection, Client } = sdk;
    const address = options?.address || process.env.TEMPORAL_ADDRESS || this.defaultAddress;
    const namespace = options?.namespace || process.env.TEMPORAL_NAMESPACE || this.defaultNamespace;
    const identity = options?.identity || process.env.TEMPORAL_CLIENT_IDENTITY || this.defaultIdentity;

    try {
      const connection = await Connection.connect({
        address,
        tls: options?.tls || undefined,
        connectTimeout: options?.connectTimeoutMs || 10_000,
      });

      const client = new Client({
        connection,
        namespace,
        identity,
      });

      return client as unknown as ITemporalClient;
    } catch (err: any) {
      throw new TemporalConnectionError(
        `Failed to connect to Temporal cluster at ${address} (namespace: ${namespace}): ${err.message}`,
        err
      );
    }
  }

  /**
   * Checks whether the client is currently instantiated.
   */
  isConnected(): boolean {
    return this.clientInstance !== null;
  }

  /**
   * Cleans up the active client connection and resets singleton state.
   */
  async close(): Promise<void> {
    if (this.clientInstance && typeof this.clientInstance.close === 'function') {
      try {
        await this.clientInstance.close();
      } catch {
        // Ignore close error on teardown
      }
    }
    this.reset();
  }

  /**
   * Resets internal singleton cached instance and promise.
   */
  reset(): void {
    this.clientInstance = null;
    this.clientPromise = null;
  }
}

export const temporalClientFactory = new TemporalClientFactory();

export async function getTemporalClient(options?: TemporalClientOptions): Promise<ITemporalClient> {
  return temporalClientFactory.getClient(options);
}
