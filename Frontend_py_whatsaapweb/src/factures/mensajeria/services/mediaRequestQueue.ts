/**
 * Sistema de cola para requests de media
 * 
 * Limita la cantidad de requests simultáneos al backend para prevenir:
 * - Errores 503 Service Unavailable
 * - Sobrecarga del servidor
 * - Desconexiones del socket por saturación
 * 
 * Features:
 * - Máximo 3 requests concurrentes (configurable)
 * - Cola FIFO para requests pendientes
 * - Timeout de 15 segundos por request
 * - Retry automático (1 intento)
 * - Cancelación de requests pendientes
 */

interface QueuedRequest<T> {
  id: string;
  priority: number; // 0 = highest
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  retries: number;
  addedAt: number;
}

class MediaRequestQueue {
  private static instance: MediaRequestQueue;
  private queue: QueuedRequest<any>[] = [];
  private activeRequests = 0;
  private readonly MAX_CONCURRENT = 3; // Máximo 3 requests simultáneos
  private readonly REQUEST_TIMEOUT = 45000; // Meta puede tardar al descargar media por primera vez
  private readonly MAX_RETRIES = 1; // 1 reintento si falla
  private readonly QUEUE_SIZE_LIMIT = 100; // Máximo 100 en cola
  
  private constructor() {}
  
  static getInstance(): MediaRequestQueue {
    if (!MediaRequestQueue.instance) {
      MediaRequestQueue.instance = new MediaRequestQueue();
    }
    return MediaRequestQueue.instance;
  }
  
  /**
   * Añade un request a la cola
   * @param id Identificador único del request (ej: messageId)
   * @param execute Función que ejecuta el request
   * @param priority Prioridad (0 = máxima, números mayores = menor prioridad)
   * @returns Promise con el resultado
   */
  async enqueue<T>(
    id: string,
    execute: () => Promise<T>,
    priority: number = 5
  ): Promise<T> {
    // Verificar si ya existe en cola (evitar duplicados)
    const existing = this.queue.find(req => req.id === id);
    if (existing) {
      console.log(`📋 [MediaQueue] Request ${id} ya está en cola, esperando...`);
      return new Promise((resolve, reject) => {
        // Sobrescribir los handlers para que este caller también reciba el resultado
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        
        existing.resolve = (value: any) => {
          originalResolve(value);
          resolve(value);
        };
        
        existing.reject = (error: any) => {
          originalReject(error);
          reject(error);
        };
      });
    }
    
    // Limitar tamaño de cola
    if (this.queue.length >= this.QUEUE_SIZE_LIMIT) {
      console.warn(`⚠️ [MediaQueue] Cola llena (${this.QUEUE_SIZE_LIMIT}), rechazando request ${id}`);
      throw new Error('Media queue is full, please try again later');
    }
    
    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id,
        priority,
        execute,
        resolve,
        reject,
        retries: 0,
        addedAt: Date.now(),
      };
      
      this.queue.push(request);
      
      // Ordenar por prioridad (menor número = mayor prioridad)
      this.queue.sort((a, b) => a.priority - b.priority);
      
      console.log(`📥 [MediaQueue] Enqueued ${id} (priority: ${priority}, queue: ${this.queue.length}, active: ${this.activeRequests})`);
      
      this.processQueue();
    });
  }
  
  private async processQueue(): Promise<void> {
    // Si ya hay suficientes requests activos, esperar
    if (this.activeRequests >= this.MAX_CONCURRENT) {
      return;
    }
    
    // Si no hay nada en cola, terminar
    if (this.queue.length === 0) {
      return;
    }
    
    // Tomar el primer request de la cola
    const request = this.queue.shift();
    if (!request) return;
    
    this.activeRequests++;
    
    console.log(`🚀 [MediaQueue] Processing ${request.id} (active: ${this.activeRequests}/${this.MAX_CONCURRENT}, remaining: ${this.queue.length})`);
    
    try {
      // Ejecutar con timeout
      const result = await this.executeWithTimeout(request);
      request.resolve(result);
      console.log(`✅ [MediaQueue] Success ${request.id}`);
    } catch (error: any) {
      // Retry logic
      if (request.retries < this.MAX_RETRIES && !error.message?.includes('timeout')) {
        request.retries++;
        console.warn(`🔄 [MediaQueue] Retry ${request.id} (${request.retries}/${this.MAX_RETRIES})`);
        
        // Re-añadir a la cola con prioridad aumentada (procesar antes)
        request.priority = Math.max(0, request.priority - 1);
        this.queue.unshift(request);
      } else {
        console.error(`❌ [MediaQueue] Failed ${request.id}:`, error.message);
        request.reject(error);
      }
    } finally {
      this.activeRequests--;
      
      // Procesar siguiente request
      this.processQueue();
    }
  }
  
  private async executeWithTimeout<T>(request: QueuedRequest<T>): Promise<T> {
    return Promise.race([
      request.execute(),
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(`Request timeout after ${this.REQUEST_TIMEOUT}ms`)), this.REQUEST_TIMEOUT)
      )
    ]);
  }
  
  /**
   * Cancela todos los requests pendientes en cola
   */
  cancelAll(): void {
    const cancelled = this.queue.length;
    this.queue.forEach(req => {
      req.reject(new Error('Request cancelled'));
    });
    this.queue = [];
    console.log(`🚫 [MediaQueue] Cancelled ${cancelled} pending requests`);
  }
  
  /**
   * Cancela requests específicos por ID
   */
  cancel(ids: string[]): void {
    const idsSet = new Set(ids);
    const remaining: QueuedRequest<any>[] = [];
    let cancelled = 0;
    
    this.queue.forEach(req => {
      if (idsSet.has(req.id)) {
        req.reject(new Error('Request cancelled'));
        cancelled++;
      } else {
        remaining.push(req);
      }
    });
    
    this.queue = remaining;
    console.log(`🚫 [MediaQueue] Cancelled ${cancelled} requests`);
  }
  
  /**
   * Obtiene estadísticas de la cola
   */
  getStats() {
    return {
      active: this.activeRequests,
      queued: this.queue.length,
      maxConcurrent: this.MAX_CONCURRENT,
      queuedByPriority: this.queue.reduce((acc, req) => {
        acc[req.priority] = (acc[req.priority] || 0) + 1;
        return acc;
      }, {} as Record<number, number>),
    };
  }
}

export const mediaQueue = MediaRequestQueue.getInstance();
