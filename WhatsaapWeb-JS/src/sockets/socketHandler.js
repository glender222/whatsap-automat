class SocketHandler {
  constructor(whatsappService) {
    this.whatsappService = whatsappService;
  }

  handleConnection(io) {
    io.on("connection", (socket) => {
      console.log("Cliente conectado:", socket.id);
      
      // Enviar lista de chats actualizada al conectarse
      socket.emit("chats-updated", this.whatsappService.getChats());
      
      // Unirse a un chat específico
      socket.on("join", async (chatId) => {
        socket.join(chatId);
        console.log(`Cliente ${socket.id} se unió al chat: ${chatId}`);
        
        // Verificar que no sea un canal antes de marcar como leído
        if (chatId.includes("@newsletter")) {
          console.log("Intento de unirse a un canal, ignorando marcado como leído");
          return;
        }
        
        try {
          await this.whatsappService.markAsRead(chatId);
        } catch (error) {
          console.error("Error marcando como leído al unirse:", error);
        }
      });

      // Salir de un chat
      socket.on("leave", (chatId) => {
        socket.leave(chatId);
        console.log(`Cliente ${socket.id} dejó el chat: ${chatId}`);
      });

      // Solicitar lista actualizada de chats
      socket.on("request-chats", () => {
        socket.emit("chats-updated", this.whatsappService.getChats());
      });

      // Notificación de mensaje enviado desde frontend
      socket.on("sent-message", (data) => {
        console.log(`Mensaje enviado notificado por cliente ${socket.id}:`, data);
      });

      // Logout desde Socket.IO
      socket.on("logout", async () => {
        try {
          console.log(`Cliente ${socket.id} solicitó logout`);
          
          await this.whatsappService.logout();
          
          socket.emit("logout-confirmed", { success: true });
          
        } catch (error) {
          console.error("Error en logout via socket:", error);
          socket.emit("logout-confirmed", { 
            success: false, 
            error: error.message 
          });
        }
      });

      socket.on("disconnect", () => {
        console.log("Cliente desconectado:", socket.id);
      });
    });
  }
}

module.exports = SocketHandler;