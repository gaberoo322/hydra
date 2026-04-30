import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || "";

export function useWebSocket() {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef(new Map());
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = WS_URL
      ? (WS_URL.startsWith("/") ? `${protocol}//${window.location.host}${WS_URL}` : WS_URL)
      : `${protocol}//${window.location.host}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Notify all listeners for this event type
        const typeListeners = listenersRef.current.get(data.type);
        if (typeListeners) {
          for (const cb of typeListeners) cb(data);
        }
        // Notify wildcard listeners
        const wildcardListeners = listenersRef.current.get("*");
        if (wildcardListeners) {
          for (const cb of wildcardListeners) cb(data);
        }
      } catch { /* ignore non-JSON messages */ }
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 3s
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((eventType, callback) => {
    if (!listenersRef.current.has(eventType)) {
      listenersRef.current.set(eventType, new Set());
    }
    listenersRef.current.get(eventType).add(callback);
    return () => {
      listenersRef.current.get(eventType)?.delete(callback);
    };
  }, []);

  return { connected, subscribe };
}
