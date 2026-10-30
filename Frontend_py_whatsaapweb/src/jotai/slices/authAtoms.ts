import { atom } from 'jotai';

// Atom para el accessToken
export const accessTokenAtom = atom<string | null>(
  typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
);

// Atom para el refreshToken
export const refreshTokenAtom = atom<string | null>(
  typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null
);

// Atom para el usuario autenticado (puedes ajustar el tipo según tu modelo de usuario)
export const userAtom = atom<any | null>(
  typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('auth') || 'null')?.user ?? null : null
);
