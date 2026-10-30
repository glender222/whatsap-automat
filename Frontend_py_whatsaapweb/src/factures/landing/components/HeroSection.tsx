import { Link } from "react-router-dom";
import Button from "./Button";

export default function HeroSection() {
  return (
    <section className="flex flex-col md:flex-row items-center justify-between px-6 md:px-10 py-16 max-w-7xl w-full mx-auto">
      <div className="flex-1 pr-6 md:pr-12 space-y-6">
        <h2 className="text-4xl md:text-5xl font-extrabold leading-tight">
          Centraliza y agiliza tus procesos de mensajería
        </h2>
        <p className="text-gray-600 max-w-md">
          Bandejas, colas priorizadas y Estadisticos en un solo lugar
        </p>
        <div className="flex flex-wrap gap-4">
          <Link to="/auth/register">
            <Button text="Regístrate gratis" />
          </Link>
          <Link to="/auth/login">
            <Button text="Iniciar sesión" variant="outline" />
          </Link>
        </div>
      </div>

      <div className="flex-1 mt-8 md:mt-0 flex items-center justify-center">
        <div className="w-full max-w-lg h-60 md:h-72 lg:h-80 bg-gray-100 rounded-md shadow-md overflow-hidden border border-gray-200">
          <video
            src="https://res.cloudinary.com/df6m46xxz/video/upload/v1759808632/Video_Generado_Gesti%C3%B3n_de_Mensajer%C3%ADa_Inteligente_dkm2bx.mp4"
            className="w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
          />
        </div>
      </div>
    </section>
  );
}
