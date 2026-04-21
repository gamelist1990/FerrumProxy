import { useEffect, useRef, useState } from 'react';
import type { WebSocketEventMap } from './api';

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const listeners = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.current.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        setLastMessage(message);

        const typeListeners = listeners.current.get(message.type);
        if (typeListeners) {
          typeListeners.forEach((callback) => callback(message));
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    return () => {
      ws.current?.close();
    };
  }, []);

  const on = <K extends keyof WebSocketEventMap>(
    type: K,
    callback: (data: WebSocketEventMap[K]) => void
  ) => {
    if (!listeners.current.has(type)) {
      listeners.current.set(type, new Set());
    }
    listeners.current.get(type)!.add(callback as (data: unknown) => void);

    return () => {
      listeners.current.get(type)?.delete(callback as (data: unknown) => void);
    };
  };

  const send = (message: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
    }
  };

  return { isConnected, lastMessage, on, send };
}
