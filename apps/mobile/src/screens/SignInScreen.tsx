import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MessagesSquare from 'lucide-react-native/icons/messages-square';
import { apiClient, MobileApiError } from '../services/apiClient';
import type { AuthSession } from '../services/authStorage';
import { DARK_THEME as colors } from '../types/navigation';

const initialServer = process.env.EXPO_PUBLIC_API_URL ?? '';

export function SignInScreen({ onSignIn, notice }: { onSignIn: (session: AuthSession) => Promise<void>; notice: string }) {
  const [server, setServer] = useState(initialServer);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const disabled = submitting || !server.trim() || !email.trim() || !password;

  async function submit() {
    if (disabled) return;
    setSubmitting(true);
    setError('');
    try {
      const session = await apiClient.signIn(server, email, password, __DEV__);
      await onSignIn(session);
    } catch (error) {
      setError(error instanceof MobileApiError && error.status === 401
        ? 'El correo o la contraseña son incorrectos.'
        : error instanceof TypeError
          ? 'No se pudo conectar. Revisa la dirección del servidor y tu red.'
          : error instanceof Error ? error.message : 'No se pudo iniciar sesión.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.form}>
            <View style={styles.brandIcon}><MessagesSquare color={colors.accent} size={28} /></View>
            <Text style={styles.brand}>WHATSAP AUTOMAT</Text>
            <Text accessibilityRole="header" style={styles.title}>Inicia sesión</Text>
            <Text style={styles.description}>Conéctate al servidor de tu empresa para atender conversaciones.</Text>
            {notice ? <Text accessibilityRole="alert" style={styles.error}>{notice}</Text> : null}

            <Text style={styles.label}>Servidor</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Dirección del servidor"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://automat.ejemplo.com"
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={server}
              onChangeText={setServer}
            />

            <Text style={styles.label}>Correo electrónico</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Correo electrónico"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!submitting}
              value={email}
              onChangeText={setEmail}
            />

            <Text style={styles.label}>Contraseña</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Contraseña"
              autoComplete="current-password"
              secureTextEntry
              editable={!submitting}
              returnKeyType="go"
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void submit()}
            />

            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable
              style={[styles.button, disabled && styles.disabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled, busy: submitting }}
              disabled={disabled}
              onPress={() => void submit()}
            >
              {submitting
                ? <ActivityIndicator accessibilityLabel="Iniciando sesión" color={colors.textPrimary} />
                : <Text style={styles.buttonLabel}>Entrar a la bandeja</Text>}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  form: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  brandIcon: {
    alignItems: 'center', justifyContent: 'center', borderRadius: 16,
    backgroundColor: colors.surfaceLight, width: 56, height: 56, marginBottom: 18,
  },
  brand: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: colors.textPrimary, fontSize: 34, fontWeight: '800', marginTop: 6 },
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 20 },
  label: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  input: {
    minHeight: 48, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface, color: colors.textPrimary, fontSize: 16,
  },
  button: { marginTop: 20, minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryHover, borderRadius: 10 },
  buttonLabel: { color: colors.textPrimary, fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.5 },
  error: { color: '#fda4af', lineHeight: 20, marginTop: 14 },
});
