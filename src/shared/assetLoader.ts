import { telemetry, EventType } from './telemetry';
import { Cache } from './cache';

export interface LoadProgress {
  loaded: number;
  total: number;
  currentFile?: string;
  speed?: number; // bytes per second
  estimatedTime?: number; // seconds
}

export interface LoaderConfig {
  maxRetries: number;
  timeoutMs: number;
  parallelRequests: number;
  chunkSize: number;
  enableStreaming: boolean;
  enableCaching: boolean;
}

export class AssetLoader {
  private config: LoaderConfig;
  private cache: Cache<string, string>;
  private activeRequests: Map<string, AbortController> = new Map();
  private progressCallbacks: ((progress: LoadProgress) => void)[] = [];

  constructor(config: Partial<LoaderConfig> = {}) {
    this.config = {
      maxRetries: 3,
      timeoutMs: 30000,
      parallelRequests: 4,
      chunkSize: 64 * 1024, // 64KB chunks
      enableStreaming: true,
      enableCaching: true,
      ...config
    };

    this.cache = new Cache('assets', {
      maxSize: 500,
      ttlMs: 24 * 60 * 60 * 1000 // 24 hours
    });
  }

  onProgress(callback: (progress: LoadProgress) => void): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const idx = this.progressCallbacks.indexOf(callback);
      if (idx >= 0) this.progressCallbacks.splice(idx, 1);
    };
  }

  private notifyProgress(progress: LoadProgress): void {
    this.progressCallbacks.forEach((cb) => {
      try {
        cb(progress);
      } catch (e) {
        console.error('Progress callback error:', e);
      }
    });
  }

  async loadText(
    url: string,
    options?: { cache?: boolean; retry?: number }
  ): Promise<string> {
    const { cache: useCache = this.config.enableCaching, retry = this.config.maxRetries } = options || {};

    // Check cache
    if (useCache) {
      const cached = this.cache.get(url);
      if (cached) return cached;
    }

    // Load with retry
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= retry; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs
        );

        this.activeRequests.set(url, controller);

        const startTime = Date.now();
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'Accept-Encoding': 'gzip, deflate, br'
          }
        });

        clearTimeout(timeoutId);
        this.activeRequests.delete(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const text = await response.text();
        const duration = Date.now() - startTime;

        telemetry.record(EventType.PERFORMANCE_METRIC, {
          type: 'asset_load',
          url,
          bytes: text.length,
          durationMs: duration,
          speedKbps: (text.length / 1024 / (duration / 1000)).toFixed(2),
          attempt
        });

        if (useCache) {
          this.cache.set(url, text);
        }

        return text;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof DOMException && error.name === 'AbortError') {
          lastError = new Error(`Timeout after ${this.config.timeoutMs}ms`);
        }

        telemetry.record(EventType.NETWORK_ERROR, {
          url,
          error: lastError.message,
          attempt,
          maxRetries: retry
        });

        if (attempt < retry) {
          const delay = 500 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Failed to load ${url}: ${lastError?.message}`);
  }

  async loadMultiple(
    urls: string[],
    options?: { parallel?: boolean; cache?: boolean }
  ): Promise<string[]> {
    const { parallel = true, cache } = options || {};
    const total = urls.length;
    let loaded = 0;

    if (!parallel) {
      const results: string[] = [];
      for (const url of urls) {
        const text = await this.loadText(url, { cache });
        results.push(text);
        loaded++;
        this.notifyProgress({ loaded, total, currentFile: url });
      }
      return results;
    }

    // Parallel with semaphore
    const results: string[] = new Array(urls.length);
    const queue = [...urls.entries()];
    const activePromises: Promise<void>[] = [];

    const processQueue = async (): Promise<void> => {
      while (queue.length > 0) {
        const [idx, url] = queue.shift()!;
        try {
          results[idx] = await this.loadText(url, { cache });
        } catch (e) {
          throw e;
        } finally {
          loaded++;
          this.notifyProgress({
            loaded,
            total,
            currentFile: url,
            estimatedTime: total - loaded > 0
              ? ((total - loaded) * ((Date.now() / (loaded * 1000)) || 1))
              : 0
          });
        }
      }
    };

    for (let i = 0; i < Math.min(this.config.parallelRequests, urls.length); i++) {
      activePromises.push(processQueue());
    }

    await Promise.all(activePromises);
    return results;
  }

  async loadAndConcatenate(urls: string[]): Promise<string> {
    const texts = await this.loadMultiple(urls, { parallel: true, cache: true });
    return texts.join('\n');
  }

  async loadAsModuleBlob(source: string): Promise<URL> {
    const blob = new Blob([source], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    return new URL(url);
  }

  async loadAsScript(source: string): Promise<any> {
    const url = await this.loadAsModuleBlob(source);
    try {
      return await import(url.href);
    } finally {
      URL.revokeObjectURL(url.href);
    }
  }

  cancel(url: string): void {
    const controller = this.activeRequests.get(url);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(url);
    }
  }

  cancelAll(): void {
    this.activeRequests.forEach((controller) => controller.abort());
    this.activeRequests.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  getStats() {
    return {
      cache: this.cache.getStats(),
      activeRequests: this.activeRequests.size
    };
  }
}

export const assetLoader = new AssetLoader({
  enableCaching: true,
  enableStreaming: true,
  parallelRequests: 6
});
