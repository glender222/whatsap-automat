
import { useEffect, useState } from "react";
import { getMessages, saveMessage, getMedia, saveMedia } from "../../../lib/db";
import { fetchAndCacheMessages } from '../services/mediaService';

export function useIndexedMessages(chatId: string) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);


  useEffect(() => {
    if (!chatId) return;
    setLoading(true);
    getMessages(chatId).then((msgs) => {
      setMessages(msgs);
      setLoading(false);
      // Si no hay mensajes locales, consulta backend y guarda en IndexedDB
      if (msgs.length === 0) {
        fetchAndCacheMessages(chatId, saveMessage, saveMedia, setMessages, setLoading, getMessages);
      }
    });
    // eslint-disable-next-line
  }, [chatId]);

  // fetchAndCacheMessages ahora está en services/mediaService.ts

  // Para obtener media desde IndexedDB (devuelve URL local para <img>/<audio>/<video>)
  const getMediaBlob = async (msgId: string): Promise<string | undefined> => {
    const blob = await getMedia(msgId);
    if (blob) return URL.createObjectURL(blob);
    return undefined;
  };

  return { messages, loading, getMediaBlob };
}