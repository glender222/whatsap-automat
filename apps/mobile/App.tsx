import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { apiClient, handleUnauthorized, type MobileApprovalCommand, type MobileTextCommand } from './src/services/apiClient';
import { authStorage, type AuthSession } from './src/services/authStorage';
import { SessionContext } from './src/services/sessionContext';
import { SignInScreen } from './src/screens/SignInScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { ChatDetailScreen } from './src/screens/ChatDetailScreen';
import { AttachmentDetailScreen } from './src/screens/AttachmentDetailScreen';
import { ApprovalDetailScreen, ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { DARK_THEME as colors, type RootStackParamList } from './src/types/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.danger,
  },
};

export default function App() {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [storageError, setStorageError] = useState<'read' | 'clear' | null>(null);
  const [signInNotice, setSignInNotice] = useState('');
  const [pendingReplies, setPendingReplies] = useState(() => new Map<string, MobileTextCommand>());
  const approvalAttempts = useRef(new Map<string, MobileApprovalCommand>());
  const currentSession = useRef<AuthSession | null>(null);

  function updateSession(value: AuthSession | null) {
    currentSession.current = value;
    setSession(value);
  }

  const restoreSession = useCallback(() => {
    setStorageError(null);
    authStorage.getAuthSession().then(updateSession).catch(() => setStorageError('read'));
  }, []);

  useEffect(restoreSession, [restoreSession]);

  const clearSession = useCallback(async (revoke = false) => {
    let previous = currentSession.current;
    currentSession.current = null;
    setSession(undefined);
    setStorageError(null);
    setPendingReplies(new Map());
    approvalAttempts.current.clear();
    try {
      previous = (await authStorage.clearAuthSession()) ?? previous;
      updateSession(null);
    } catch {
      setStorageError('clear');
    } finally {
      if (revoke && previous) void apiClient.signOut(previous).catch(() => undefined);
    }
  }, []);

  useEffect(() => handleUnauthorized(() => {
    setSignInNotice('Tu sesión terminó. Inicia sesión para continuar.');
    void clearSession();
  }), [clearSession]);

  async function signIn(value: AuthSession) {
    await authStorage.saveAuthSession(value);
    updateSession(value);
  }

  function signOut() {
    setSignInNotice('');
    void clearSession(true);
  }

  const rememberReply = useCallback((chatId: string, command: MobileTextCommand) => {
    if (!session || currentSession.current !== session) return;
    setPendingReplies((current) => new Map(current).set(chatId, command));
  }, [session]);

  const forgetReply = useCallback((chatId: string, command: MobileTextCommand) => {
    setPendingReplies((current) => {
      if (current.get(chatId) !== command) return current;
      const next = new Map(current);
      next.delete(chatId);
      return next;
    });
  }, []);

  const isSessionActive = useCallback(() => currentSession.current === session, [session]);

  let screen = (
    <View style={styles.center}>
      <ActivityIndicator accessibilityLabel="Abriendo Whatsap Automat" size="large" color={colors.accent} />
    </View>
  );
  if (storageError) {
    screen = (
      <View style={styles.center}>
        <Text accessibilityRole="alert" style={styles.label}>No se pudo acceder al almacenamiento seguro.</Text>
        <Pressable accessibilityRole="button" style={styles.retry} onPress={storageError === 'read' ? restoreSession : () => void clearSession()}>
          <Text style={styles.label}>Volver a intentar</Text>
        </Pressable>
      </View>
    );
  } else if (session === null) {
    screen = <SignInScreen onSignIn={signIn} notice={signInNotice} />;
  } else if (session) {
    screen = (
      <SessionContext.Provider value={{ session, signOut, isSessionActive, pendingReplies, rememberReply, forgetReply, approvalAttempts: approvalAttempts.current }}>
        <NavigationContainer theme={navigationTheme}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Inbox" component={InboxScreen} />
            <Stack.Screen name="ChatDetail" component={ChatDetailScreen} />
            <Stack.Screen name="AttachmentDetail" component={AttachmentDetailScreen} />
            <Stack.Screen name="Approvals" component={ApprovalsScreen} />
            <Stack.Screen name="ApprovalDetail" component={ApprovalDetailScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </SessionContext.Provider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.background },
  label: { color: colors.textPrimary, textAlign: 'center', fontSize: 15 },
  retry: { backgroundColor: colors.primaryHover, padding: 12, borderRadius: 8 },
});
