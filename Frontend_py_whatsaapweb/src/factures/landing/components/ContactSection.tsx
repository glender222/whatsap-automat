import { sendMessage } from "../services/contactService";

export default function ContactSection() {
  const handleClick = () => {
    sendMessage("Solicitar información sobre planes");
  };

  return (
    <section id="contacto" className="py-12 md:py-16 px-4 md:px-10 bg-gray-100 text-center">
      <h3 className="text-2xl md:text-3xl font-bold mb-6 md:mb-10">Contáctanos</h3>
      <div className="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-10 max-w-5xl mx-auto">
        <img src="/contact.png" alt="Contacto" className="w-48 md:w-72 rounded-lg shadow-md" />
        <div className="text-left space-y-2 text-sm md:text-base">
          <p>• grupo de programadores SAG S.A.A</p>
          <p>• 925593795</p>
          <p>• Los pro@gmail.com</p>
          <button
            onClick={handleClick}
            className="mt-4 px-4 md:px-6 py-2 bg-green-600 text-white text-sm md:text-base rounded-md hover:bg-green-700 transition-colors"
          >
            Enviar mensaje
          </button>
        </div>
      </div>
    </section>
  );
}
