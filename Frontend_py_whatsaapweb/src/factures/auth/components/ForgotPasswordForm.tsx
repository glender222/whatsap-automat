import { useState } from "react";
import { Mail, ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Aquí iría la lógica para enviar el correo de recuperación
    console.log("Recuperar contraseña para:", email);
    setSubmitted(true);
  };

  const handleBack = () => {
    navigate("/");
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 text-center relative">
          {/* Botón de atrás */}
          <button
            type="button"
            onClick={handleBack}
            className="absolute right-0 top-0 bg-[#0d1740] hover:bg-[#172a50] w-16 h-16 flex items-center justify-center rounded-tr-2xl transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft className="w-8 h-8 text-white" strokeWidth={2.5} />
          </button>
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Mail className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold mb-4">Revisa tu correo</h2>
          <p className="text-gray-600 mb-6">
            Te hemos enviado instrucciones para restablecer tu contraseña a{" "}
            <span className="font-semibold">{email}</span>
          </p>
          <Link
            to="/auth/login"
            className="inline-flex items-center gap-2 text-green-600 hover:text-green-700 font-semibold"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver al inicio de sesión
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 relative">
        {/* Botón de atrás */}
        <button
          type="button"
          onClick={handleBack}
          className="absolute right-0 top-0 bg-[#0d1740] hover:bg-[#172a50] w-16 h-16 flex items-center justify-center rounded-tr-2xl transition-colors"
          aria-label="Volver"
        >
          <ArrowLeft className="w-8 h-8 text-white" strokeWidth={2.5} />
        </button>

        {/* Icono */}
        <div className="flex items-center justify-center mb-6">
          <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center">
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center">
              <span className="text-green-500 text-lg font-bold">W</span>
            </div>
          </div>
        </div>

        {/* Título */}
        <h2 className="text-3xl font-bold text-center mb-2">¿Olvidaste tu contraseña?</h2>
        <p className="text-gray-600 text-center mb-8">
          Ingresa tu correo electrónico y te enviaremos instrucciones para restablecerla
        </p>

        {/* Formulario */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Campo de correo */}
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="email"
              placeholder="Correo electrónico"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              required
            />
          </div>

          {/* Botón de enviar */}
          <button
            type="submit"
            className="w-full bg-green-500 hover:bg-green-600 text-white font-semibold py-3 rounded-lg transition-colors"
          >
            Enviar instrucciones
          </button>

          {/* Link de regreso */}
          <div className="text-center">
            <Link
              to="/auth/login"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-green-600 text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver al inicio de sesión
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
