import { useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Eye, EyeOff } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { userService } from '../../../shared/services/userService';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

const inputClass = 'mt-1 min-h-12 w-full rounded-lg border border-gray-300 px-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-700';
const mismatchMessage = 'Las contraseñas no coinciden.';

function PasswordField({ id, label, value, onChange, describedBy }: {
  id: string; label: string; value: string; onChange: (value: string) => void; describedBy: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      <div className="relative">
        <input id={id} name={id} type={visible ? 'text' : 'password'} value={value}
          autoComplete="new-password" aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)} className={inputClass + ' pr-12'} required />
        <button type="button" aria-controls={id} aria-label={visible ? 'Ocultar ' + label.toLowerCase() : 'Mostrar ' + label.toLowerCase()}
          onClick={() => setVisible((current) => !current)}
          className="absolute bottom-0 right-0 grid h-12 w-12 place-items-center rounded-lg text-gray-600 hover:text-gray-900">
          {visible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export default function RegisterForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const navigate = useNavigate();
  const { saveAuth } = useAuthJotai();
  const { saveUserRole } = useUserRoleJotai();

  const requirements = [
    { label: 'Mínimo 8 caracteres', met: password.length >= 8 },
    { label: 'Incluye un número', met: /\d/.test(password) },
    { label: 'Incluye un símbolo como !, @ o #', met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
  ];
  const passwordsMatch = password === confirmation && confirmation !== '';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    const issue = !name.trim() ? { field: 'register-name', message: 'Escribe tu nombre.' }
      : !requirements.every((requirement) => requirement.met)
        ? { field: 'register-password', message: 'La contraseña no cumple con los requisitos.' }
        : !passwordsMatch ? { field: 'register-confirm-password', message: mismatchMessage } : null;
    if (issue) {
      setError(issue.message);
      (event.currentTarget.elements.namedItem(issue.field) as HTMLInputElement | null)?.focus();
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      const result = await userService.register({ nombre: name.trim(), email: email.trim(), password });
      const role = result.user.rol === 'ADMIN' ? 'ADMIN' : 'EMPLEADO';
      saveAuth(result.user, result.accessToken, result.refreshToken);
      saveUserRole(role);
      navigate(role === 'ADMIN' ? '/dashboard' : '/gestion-web/inicio', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'No se pudo completar el registro.');
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-3 sm:p-4">
      <div className="w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-xl md:grid md:grid-cols-2">
        <div className="hidden flex-col justify-center gap-4 bg-emerald-50 p-10 text-emerald-950 md:flex">
          <span className="grid h-14 w-14 place-items-center rounded-xl bg-emerald-800 text-xl font-bold text-white" aria-hidden="true">W</span>
          <p className="text-3xl font-semibold">Gestione sus pedidos de mensajería</p>
          <p className="text-sm text-emerald-900">de forma eficiente</p>
        </div>
        <div className="p-6 sm:p-8">
          <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-800 hover:underline">
            <ArrowLeft size={17} aria-hidden="true" /> Volver al inicio
          </Link>
          <h1 className="mb-5 text-2xl font-bold sm:text-3xl">Registro</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="register-name" className="text-sm font-semibold">Nombre</label>
              <input id="register-name" name="register-name" type="text" autoComplete="name" value={name}
                onChange={(event) => setName(event.target.value)} className={inputClass} required />
            </div>
            <div>
              <label htmlFor="register-email" className="text-sm font-semibold">Correo electrónico</label>
              <input id="register-email" name="email" type="email" autoComplete="email" value={email}
                onChange={(event) => setEmail(event.target.value)} className={inputClass} required />
            </div>
            <PasswordField id="register-password" label="Contraseña" value={password} onChange={setPassword} describedBy="register-requirements" />
            <ul id="register-requirements" className="space-y-1 text-sm text-gray-700">
              {requirements.map(({ label, met }) => (
                <li key={label} className="flex items-center gap-2">
                  {met ? <Check size={16} className="text-emerald-700" aria-hidden="true" /> : <span className="w-4 text-center" aria-hidden="true">·</span>}
                  {label}<span className="sr-only"> {met ? 'Cumplido' : 'Pendiente'}</span>
                </li>
              ))}
            </ul>
            <PasswordField id="register-confirm-password" label="Confirmación de contraseña" value={confirmation}
              onChange={(value) => { setConfirmation(value); if (error === mismatchMessage) setError(''); }} describedBy="register-match" />
            {error === mismatchMessage ? (
              <p key="error" id="register-match" role="alert" className="text-sm text-red-800">{mismatchMessage}</p>
            ) : (
              <p key="hint" id="register-match" className="text-sm text-gray-700">
                {confirmation ? (passwordsMatch ? 'Las contraseñas coinciden.' : mismatchMessage) : 'Escribe de nuevo tu contraseña.'}
              </p>
            )}
            {error && error !== mismatchMessage && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            <button type="submit" disabled={loading}
              className="min-h-12 w-full rounded-lg bg-emerald-700 px-3 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
              {loading ? 'Creando cuenta…' : 'Crear cuenta'}
            </button>
            <div className="text-center">
              <Link to="/auth/login" className="inline-flex min-h-11 items-center text-sm text-emerald-800 underline">Ya tengo cuenta</Link>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
