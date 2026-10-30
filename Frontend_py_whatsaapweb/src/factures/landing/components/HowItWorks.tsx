export default function HowItWorks() {
  const features = [
    { title: "Recibe y organiza pedidos" },
    { title: "Prioriza y ordena estados" },
    { title: "Bandeja de entrada por tipos" },
    { title: "Colas priorizadas" },
    { title: "Panel de chat" },
    { title: "Bot de chat programable" },
    { title: "Filtros y búsquedas" },
    { title: "Lo puedes usar en cualquier dispositivo" },
    { title: "usa la vercion gratuita como whatsapp web" },
  ];

  return (
    <section id="funciones" className="py-12 md:py-20 px-4 md:px-10 bg-gray-50 text-center">
      <h3 className="text-2xl md:text-3xl font-bold mb-6 md:mb-10">¿Cómo funciona?</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 md:gap-6 max-w-5xl mx-auto">
        {features.map((f, i) => (
          <div
            key={i}
            className="bg-white shadow-sm rounded-xl p-4 md:p-6 hover:shadow-md transition"
          >
            <p className="text-sm md:text-base font-medium">{f.title}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
