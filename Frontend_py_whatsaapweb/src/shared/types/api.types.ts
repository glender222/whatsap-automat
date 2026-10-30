// Tipos para respuestas de API
export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data: T;
  timestamp: string;
}

// Tipos base para entidades
export interface BaseEntity {
  id: number;
  createdAt?: string;
  updatedAt?: string;
}

// Tipos para manejo de errores
export interface ApiError {
  message: string;
  code?: string;
  details?: any;
}