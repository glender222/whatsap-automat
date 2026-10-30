const DB_NAME = "wspApp";
const DB_VERSION = 2; // ⬆️ Incrementado para agregar nueva tabla
let db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("messages")) {
        db.createObjectStore("messages", { keyPath: "id" }); // id: `${chatId}_${msgId}`
      }
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media", { keyPath: "id" }); // id: `${msgId}` o `${chatId}_${msgId}`
      }
      // Nueva tabla para fotos de perfil
      if (!db.objectStoreNames.contains("profilePhotos")) {
        const store = db.createObjectStore("profilePhotos", { keyPath: "chatId" });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

// Guardar mensaje (con/ sin mediaId)
export async function saveMessage(message: any) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(message);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Leer todos los mensajes de un chat
export async function getMessages(chatId: string): Promise<any[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const req = store.getAll();
    req.onsuccess = () => {
      resolve(req.result.filter((m: any) => m.chatId === chatId));
    };
    req.onerror = () => reject(req.error);
  });
}

// Guardar archivo blob (foto, audio, video, pdf)
export async function saveMedia(id: string, blob: Blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readwrite");
    tx.objectStore("media").put({ id, blob });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Leer blob de media
export async function getMedia(id: string): Promise<Blob | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const req = tx.objectStore("media").get(id);
    req.onsuccess = () => {
      if (req.result) resolve(req.result.blob);
      else resolve(undefined);
    };
    req.onerror = () => reject(req.error);
  });
}

// Eliminar todo local (opcional)
export async function clearAll() {
  const db = await openDB();
  await Promise.all([
    new Promise<void>((res) => db!.transaction("messages", "readwrite").objectStore("messages").clear().onsuccess = () => res()),
    new Promise<void>((res) => db!.transaction("media", "readwrite").objectStore("media").clear().onsuccess = () => res()),
    new Promise<void>((res) => db!.transaction("profilePhotos", "readwrite").objectStore("profilePhotos").clear().onsuccess = () => res()),
  ]);
}

// ==================== FUNCIONES PARA FOTOS DE PERFIL ====================

/**
 * Guarda la URL de la foto de perfil en IndexedDB
 * @param chatId ID del chat
 * @param url URL de la foto de perfil
 */
export async function saveProfilePhoto(chatId: string, url: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("profilePhotos", "readwrite");
    tx.objectStore("profilePhotos").put({
      chatId,
      url,
      timestamp: Date.now()
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Obtiene la URL de la foto de perfil desde IndexedDB
 * @param chatId ID del chat
 * @returns URL de la foto o undefined si no existe
 */
export async function getProfilePhoto(chatId: string): Promise<string | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("profilePhotos", "readonly");
    const req = tx.objectStore("profilePhotos").get(chatId);
    req.onsuccess = () => {
      if (req.result) {
        resolve(req.result.url);
      } else {
        resolve(undefined);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Obtiene todas las fotos de perfil almacenadas
 * @returns Mapa de chatId -> URL
 */
export async function getAllProfilePhotos(): Promise<Map<string, string>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("profilePhotos", "readonly");
    const req = tx.objectStore("profilePhotos").getAll();
    req.onsuccess = () => {
      const map = new Map<string, string>();
      for (const item of req.result) {
        map.set(item.chatId, item.url);
      }
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Elimina una foto de perfil específica
 * @param chatId ID del chat
 */
export async function deleteProfilePhoto(chatId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("profilePhotos", "readwrite");
    tx.objectStore("profilePhotos").delete(chatId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}