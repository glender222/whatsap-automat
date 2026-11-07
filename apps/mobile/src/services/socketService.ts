/**
 * Real-Time Socket.IO Client for Mobile
 * Handles tenant-scoped and conversation-scoped real-time updates.
 */

import { io, Socket } from 'socket.io-client';
import { ConversationMessageV1 } from '@whatsap-automat/contracts';
import { authStorage } from './authStorage';

export interface ConversationUpdatedEvent {
  conversationId: string;
  version: number;
  tenantId?: string;
  eventId?: string;
}

export interface TypingEvent {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export class MobileSocketService {
  private static instance: MobileSocketService;
  private socket: Socket | null = null;
  private joinedRooms = new Set<string>();

  private constructor() {}

  public static getInstance(): MobileSocketService {
    if (!MobileSocketService.instance) {
      MobileSocketService.instance = new MobileSocketService();
    }
    return MobileSocketService.instance;
  }

  public async connect(): Promise<Socket> {
    if (this.socket && this.socket.connected) {
      return this.socket;
    }

    const apiUrl = await authStorage.getApiUrl();
    const token = await authStorage.getAccessToken();

    // Remove /api/v1 to reach the root Socket.IO endpoint
    const socketUrl = apiUrl.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');

    this.socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      timeout: 15000,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: {
        token: token || '',
      },
    });

    this.socket.on('connect', () => {
      // Re-join any previously tracked active conversation rooms
      for (const room of this.joinedRooms) {
        this.socket?.emit('join_conversation', { conversationId: room });
      }
    });

    this.socket.on('connect_error', (_err) => {
      // Automatic error handling
    });

    return this.socket;
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.joinedRooms.clear();
  }

  public async joinConversation(conversationId: string): Promise<boolean> {
    const socket = await this.connect();
    this.joinedRooms.add(conversationId);

    return new Promise((resolve) => {
      socket.emit(
        'join_conversation',
        { conversationId },
        (res: { success: boolean; error?: string }) => {
          if (res && res.success) {
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );
      // Fallback timer if server does not support ack callback
      setTimeout(() => resolve(true), 500);
    });
  }

  public leaveConversation(conversationId: string): void {
    this.joinedRooms.delete(conversationId);
    if (this.socket && this.socket.connected) {
      this.socket.emit('leave_conversation', { conversationId });
    }
  }

  public onConversationUpdated(
    callback: (event: ConversationUpdatedEvent) => void
  ): () => void {
    if (!this.socket) return () => {};

    const handler = (event: ConversationUpdatedEvent) => {
      callback(event);
    };

    this.socket.on('conversation.updated', handler);
    return () => {
      this.socket?.off('conversation.updated', handler);
    };
  }

  public onMessageCreated(
    callback: (message: ConversationMessageV1) => void
  ): () => void {
    if (!this.socket) return () => {};

    const handler = (message: ConversationMessageV1) => {
      callback(message);
    };

    this.socket.on('message.created', handler);
    return () => {
      this.socket?.off('message.created', handler);
    };
  }

  public emitTyping(conversationId: string, isTyping: boolean): void {
    if (this.socket && this.socket.connected) {
      this.socket.emit('agent:typing', { conversationId, isTyping });
    }
  }

  public onTyping(callback: (event: TypingEvent) => void): () => void {
    if (!this.socket) return () => {};

    const handler = (event: TypingEvent) => {
      callback(event);
    };

    this.socket.on('agent:typing', handler);
    return () => {
      this.socket?.off('agent:typing', handler);
    };
  }
}

export const socketService = MobileSocketService.getInstance();
