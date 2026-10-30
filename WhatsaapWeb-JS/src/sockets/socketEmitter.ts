import { Server } from 'socket.io';

let ioInstance: Server | null = null;

export function setSocketIo(io: Server): void {
  ioInstance = io;
}

export function emitDashboard(event: string, payload: unknown): void {
  if (!ioInstance) return;
  try {
    ioInstance.emit(event, payload);
  } catch (error) {
    console.error(`Error emitiendo evento socket ${event}:`, error);
  }
}

export function emitToRoom(room: string, event: string, payload: unknown): void {
  if (!ioInstance) return;
  try {
    ioInstance.to(room).emit(event, payload);
  } catch (error) {
    console.error(`Error emitiendo evento socket ${event} a room ${room}:`, error);
  }
}
