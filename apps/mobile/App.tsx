/**
 * Root Application Component for Whatsap-Automat Mobile
 * Provides Navigation Container, Theme Styling, and Auth Guard.
 */

import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { authStorage } from './src/services/authStorage';
import { InboxScreen } from './src/screens/InboxScreen';
import { ChatDetailScreen } from './src/screens/ChatDetailScreen';
import { RootStackParamList, DARK_THEME } from './src/types/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function initSession() {
      const isAuthed = await authStorage.isAuthenticated();
      if (!isAuthed) {
        // Seed default development / test session for instant mobile inbox evaluation
        await authStorage.saveAuthSession({
          accessToken: 'mock_jwt_mobile_agent_token',
          refreshToken: 'mock_refresh_token',
          tenantId: '1',
          userId: '101',
          apiUrl: 'http://localhost:3000/api/v1',
        });
      }
      setIsReady(true);
    }
    initSession();
  }, []);

  if (!isReady) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={DARK_THEME.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={DARK_THEME.background} />
      <NavigationContainer
        theme={{
          dark: true,
          colors: {
            primary: DARK_THEME.primary,
            background: DARK_THEME.background,
            card: DARK_THEME.surface,
            text: DARK_THEME.textPrimary,
            border: DARK_THEME.border,
            notification: DARK_THEME.danger,
          },
        }}
      >
        <Stack.Navigator
          initialRouteName="Inbox"
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: DARK_THEME.background },
          }}
        >
          <Stack.Screen name="Inbox" component={InboxScreen} />
          <Stack.Screen name="ChatDetail" component={ChatDetailScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: DARK_THEME.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
