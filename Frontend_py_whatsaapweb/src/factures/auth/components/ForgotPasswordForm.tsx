import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function ForgotPasswordForm() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-3 sm:p-4">
      <section className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-xl sm:p-8" aria-labelledby="recovery-title">
        <h1 id="recovery-title" className="text-2xl font-bold sm:text-3xl">Recuperar contraseña</h1>
        <p className="text-sm text-gray-700">La recuperación de contraseña por correo está pendiente de configuración.</p>
        <Link to="/auth/login" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-800 underline">
          <ArrowLeft size={17} aria-hidden="true" /> Volver al inicio de sesión
        </Link>
      </section>
    </main>
  );
}
