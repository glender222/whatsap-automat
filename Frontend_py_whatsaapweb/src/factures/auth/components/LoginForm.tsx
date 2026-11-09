import { useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { authService } from '../services/authService';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

const inputClass = 'mt-1 min-h-12 w-full rounded-lg border border-gray-300 px-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-700';

export default function LoginForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const navigate = useNavigate();
  const { saveAuth } = useAuthJotai();
  const { saveUserRole } = useUserRoleJotai();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    submitting.current = true;
    setLoading(true);
    try {
      const result = await authService.login({ email: email.trim(), password });
      const role = result.user.rol === 'ADMIN' ? 'ADMIN' : 'EMPLEADO';
      saveAuth(result.user, result.accessToken, result.refreshToken);
      saveUserRole(role);
      navigate(role === 'ADMIN' ? '/dashboard' : '/gestion-web/inicio', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'No se pudo iniciar sesión.');
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-3 sm:p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl sm:p-8">
        <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-800 hover:underline">
          <ArrowLeft size={17} aria-hidden="true" /> Volver al inicio
        </Link>
        <h1 className="mb-6 text-2xl font-bold sm:text-3xl">Iniciar sesión</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className="text-sm font-semibold">Correo electrónico</label>
            <input id="login-email" name="email" type="text" inputMode="email" autoComplete="username"
              autoCapitalize="none" spellCheck={false} value={email}
              onChange={(event) => setEmail(event.target.value)} className={inputClass} required />
          </div>
          <div>
            <label htmlFor="login-password" className="text-sm font-semibold">Contraseña</label>
            <div className="relative">
              <input id="login-password" name="password" type={showPassword ? 'text' : 'password'}
                autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}
                className={inputClass + ' pr-12'} required />
              <button type="button" onClick={() => setShowPassword((current) => !current)} aria-controls="login-password"
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                className="absolute bottom-0 right-0 grid h-12 w-12 place-items-center rounded-lg text-gray-600 hover:text-gray-900">
                {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <Link to="/auth/forgot-password" className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline">
            Olvidé mi contraseña
          </Link>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          <button type="submit" disabled={loading}
            className="min-h-12 w-full rounded-lg bg-emerald-700 px-3 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
            {loading ? 'Ingresando…' : 'Iniciar sesión'}
          </button>
          <div className="text-center">
            <Link to="/auth/register" className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline">Crear cuenta</Link>
          </div>
        </form>
      </div>
    </main>
  );
}
